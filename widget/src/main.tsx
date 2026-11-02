/**
 * Demo storefront chat: CopilotKit v2 speaks AG-UI directly to the selected
 * AWS backend. The two cart tools execute in the browser.
 */
import { HttpAgent, type MiddlewareFunction } from '@ag-ui/client';
import {
  CopilotKitProvider,
  CopilotPopup,
  type Message,
  useFrontendTool,
} from '@copilotkit/react-core/v2';
import '@copilotkit/react-core/v2/styles.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';

type Backend = {
  id: string;
  url: string;
  sessionHeader?: string;
};

declare global {
  interface Window {
    WIDGET_CONFIG?: { authUrl?: string; activeBackend?: Backend };
  }
}

type BasketItem = { productId: string; title: string; quantity: number };

// Keep the same conversation across requests and backend switches. AgentCore
// requires a session id of at least 33 characters.
function sessionId(): string {
  const existing = localStorage.getItem('sample-session-id');
  if (existing) return existing;

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = `sample-session-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  localStorage.setItem('sample-session-id', id);
  return id;
}

async function fetchToken(authUrl: string): Promise<string> {
  const response = await fetch(`${authUrl.replace(/\/+$/, '')}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'sample-chat' }),
  });
  const data = (await response.json()) as { access_token?: string };
  if (!response.ok || !data.access_token) throw new Error(`HTTP ${response.status}`);
  return data.access_token;
}

// Strands restores earlier messages from S3, so send only the latest message.
// In particular, a frontend tool's result is sent in its own follow-up run.
const newestMessageOnly: MiddlewareFunction = (input, next) =>
  next.run({ ...input, messages: input.messages.slice(-1) });

function Widget() {
  const [items, setItems] = useState<BasketItem[]>([]);

  useFrontendTool(
    {
      name: 'add_to_cart',
      description:
        'Add a product to the cart. First find it with search_products, then use its id and title.',
      parameters: z.object({
        productId: z.string().describe('Product id returned by search_products'),
        title: z.string().describe('Exact product title returned by search_products'),
        quantity: z.number().int().positive().optional().describe('Units to add; defaults to 1'),
      }),
      handler: async ({ productId, title, quantity = 1 }) => {
        setItems((current) => {
          const found = current.some((item) => item.productId === productId);
          return found
            ? current.map((item) =>
                item.productId === productId
                  ? { ...item, quantity: item.quantity + quantity }
                  : item,
              )
            : [...current, { productId, title, quantity }];
        });
        return `Added ${quantity} × "${title}" to the cart.`;
      },
    },
    [],
  );

  useFrontendTool(
    {
      name: 'get_cart_content',
      description: 'Return the current cart contents. Use this result to answer cart questions.',
      parameters: z.object({}),
      handler: async () => ({ items }),
    },
    [items],
  );

  return (
    <>
      <section className="basket" data-testid="basket">
        <h2>Your basket</h2>
        {items.length === 0 ? (
          <p data-testid="basket-empty">Empty — ask the chat to add a product.</p>
        ) : (
          <ul data-testid="basket-items">
            {items.map((item) => (
              <li key={item.productId} data-testid="basket-item">
                {item.title} × {item.quantity}
              </li>
            ))}
          </ul>
        )}
        <p>
          <button
            type="button"
            data-testid="basket-clear"
            disabled={items.length === 0}
            onClick={() => setItems([])}
          >
            Clear basket
          </button>
        </p>
      </section>
      <CopilotPopup
        labels={{
          modalHeaderTitle: 'sample chat',
          welcomeMessageText:
            'Ask about the demo products — try “Which product is good for sleep?” — or tell me to put one in your basket.',
        }}
        messageView={{
          transformMessages: (messages: Message[]) =>
            messages.filter((message) => message.role !== 'reasoning'),
        }}
      />
    </>
  );
}

async function boot(): Promise<void> {
  const config = window.WIDGET_CONFIG ?? {};
  const active = config.activeBackend;
  if (!active?.url) return; // The hosting page displays the configuration error.

  const errorBox = document.getElementById('widget-error')!;
  const authUrl = new URLSearchParams(location.search).get('authUrl') ?? config.authUrl;
  let token: string | undefined;

  if (authUrl) {
    try {
      token = await fetchToken(authUrl);
    } catch (error) {
      errorBox.textContent = `Could not get an auth token (${String(error)}) — the chat will not connect.`;
      errorBox.hidden = false;
      return;
    }
  }

  const session = sessionId();
  const agent = new HttpAgent({
    url: `${active.url.replace(/\/+$/, '')}/invocations`,
    threadId: session,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(active.sessionHeader ? { [active.sessionHeader]: session } : {}),
    },
  });
  agent.use(newestMessageOnly);

  createRoot(document.getElementById('root')!).render(
    <CopilotKitProvider agentId="default" selfManagedAgents={{ default: agent }}>
      <Widget />
    </CopilotKitProvider>,
  );
}

void boot();
