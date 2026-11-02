# E-commerce AI agent on AWS Serverless

This repository contains the sample application from [Part 7: The Sample Application](https://www.serverlesslife.com/Building_an_Ecommerce_AI_Agent_with_AWS_Serverless_Part_7_The_Sample_Application.html) of the **Building an E-commerce AI Agent with AWS Serverless** series. It demonstrates a small webshop assistant with real product search, persistent conversation memory, a browser chat widget, and the same TypeScript agent running on four AWS serverless configurations.

Read the full **Building an E-commerce AI Agent with AWS Serverless** series:

1. [Understanding AI Agents](https://www.serverlesslife.com/Building_an_Ecommerce_AI_Agent_with_AWS_Serverless_Part_1_Understanding_AI_Agents.html)
2. [Choosing the Right Runtime](https://www.serverlesslife.com/Building_an_Ecommerce_AI_Agent_with_AWS_Serverless_Part_2_Choosing_the_Right_Runtime.html)
3. [Building Product Search and RAG](https://www.serverlesslife.com/Building_an_Ecommerce_AI_Agent_with_AWS_Serverless_Part_3_Building_Product_Search_and_RAG.html)
4. [Conversation Memory and Context Management](https://www.serverlesslife.com/Building_an_Ecommerce_AI_Agent_with_AWS_Serverless_Part_4_Conversation_Memory_and_Context_Management.html)
5. [Connecting the Agent to Your Webshop](https://www.serverlesslife.com/Building_an_Ecommerce_AI_Agent_with_AWS_Serverless_Part_5_Connecting_the_Agent_to_Your_Webshop.html)
6. [Security, Privacy, and Observability](https://www.serverlesslife.com/Building_an_Ecommerce_AI_Agent_with_AWS_Serverless_Part_6_Security_Privacy_and_Observability.html)
7. **[The Sample Application](https://www.serverlesslife.com/Building_an_Ecommerce_AI_Agent_with_AWS_Serverless_Part_7_The_Sample_Application.html)**

## The Sample Application

The implementation brings together the concepts explored in the series: product search, session persistence, client-side tools, authentication, and deployment across different AWS runtimes.

The application is deliberately simple: a shopping assistant for a demo store. Customers can search for products, ask follow-up questions, and add products to their cart. The implementation nevertheless includes authentication, persistent conversation memory, vector search, streaming responses, and browser-side tools.

We deploy the same agent to four AWS runtime configurations to compare their behavior, performance, and cost without changing business logic.

### Architecture

The application consists of a [React and CopilotKit frontend](widget/src/main.tsx), a [TypeScript Strands agent](strands-agent/AgentService.ts), [DynamoDB vector search](services/ProductService.ts), [S3-backed Strands session management](strands-agent/AgentService.ts), [KMS-signed JWT authentication](services/AuthService.ts), and [AWS CDK infrastructure](infra).

It runs on Lambda Event, Lambda Web Functions, AgentCore Runtime V1, and AgentCore Runtime V2. All four share the same agent implementation; only request handling, streaming, authorization, and lifecycle differ. We discussed these trade-offs in [Part 2: Picking a runtime](https://www.serverlesslife.com/Building_an_Ecommerce_AI_Agent_with_AWS_Serverless_Part_2_Choosing_the_Right_Runtime.html#picking-a-runtime).

#### Repository structure

- [strands-agent/](strands-agent/) — Agent definition, prompt, tools, and context management

- [services/](services/) — Product search, embeddings, and authentication

- [lambda-event/](lambda-event/) — Lambda Event Function transport

- [lambda-web/](lambda-web/) — Lambda Web Functions transport

- [agentcore/](agentcore/) — AgentCore HTTP transport

- [widget/](widget/) — React widget, demo cart, and example host page

- [infra/](infra/) — AWS CDK deployment

- [scripts/](scripts/) — Product import and utilities

- [price-perfomance-test/](price-perfomance-test/) — Load, billing, and performance tests

This repository is organized as an npm workspace. Shared services are imported by all the transports rather than duplicated.

### Building the agent

**The agent is defined in [strands-agent/AgentService.ts](strands-agent/AgentService.ts).** Strands handles the loop of model calls, tool requests, tool execution, and responses.

#### Model selection

**The sample uses gpt-oss-20b through Amazon Bedrock, selected in [infra/lib/Config.ts](infra/lib/Config.ts).** The [BedrockModel configuration](strands-agent/AgentService.ts#L51-L57) limits responses to 1,024 output tokens and explicitly sets the context window to 131,072 tokens. Shopping responses should be short: users want recommendations, not essays.

#### System prompt and tool instructions

The [system prompt](strands-agent/AgentService.ts#L24-L28) is short for this demo; a production agent should extend it with instructions tailored to the webshop and its requirements. It tells the agent to answer product questions only from `search_products` results, prefer a loose but real match over inventing products, add only products returned by search, and check the current cart using the result returned by the browser's `get_cart_content` tool. These rules reduce mistakes, but application validation is still necessary.

#### Product search as a tool

The single server-side tool is [search_products](strands-agent/AgentService.ts#L31-L46). The tool delegates to [ProductService.searchProductCatalog()](services/ProductService.ts#L69-L94) and returns JSON. Search logic stays separate from the agent.

### Product search with DynamoDB Vector Search

In [Part 3: Building a Serverless Data Ingestion Pipeline](https://www.serverlesslife.com/Building_an_Ecommerce_AI_Agent_with_AWS_Serverless_Part_3_Building_Product_Search_and_RAG.html#building-a-serverless-data-ingestion-pipeline), we described a complete ETL pipeline. This sample deliberately omits the crawler and imports a public demo catalogue, allowing us to focus on search. [Part 3: From Product Pages to Vector Search](https://www.serverlesslife.com/Building_an_Ecommerce_AI_Agent_with_AWS_Serverless_Part_3_Building_Product_Search_and_RAG.html#from-product-pages-to-vector-search) explains the ingestion, embeddings, and retrieval architecture behind this implementation.

#### Preparing product data

The [seed script](scripts/seed.ts) downloads products from DummyJSON, embeds each title and description, and writes a DynamoDB record. [EmbeddingService.embedText()](services/EmbeddingService.ts#L10-L29) invokes Titan Text Embeddings V2 with 1,024 dimensions and normalization enabled.

The same embedding model is used for catalogue records and customer questions. Without a shared vector space, similarity comparisons would not be meaningful.

#### Vector search

The [DynamoDB table and vector index](infra/lib/SharedStack.ts#L38-L55) use cosine distance. The index is declared through a CloudFormation property override because the CDK construct in the sample does not yet expose the setting directly.

On each search, the service creates a query embedding and calls [SearchVectorsCommand](services/ProductService.ts#L78-L86). When reranking is enabled, it retrieves 50 cosine candidates so a second model has enough results to reevaluate. When reranking is disabled, it asks DynamoDB directly for the final five results.

The optional [Bedrock RerankCommand](services/ProductService.ts#L40-L61) reevaluates the 50 candidates and returns the best five. Reranking is [disabled in the current config](infra/lib/Config.ts).

### Persistent conversation memory

We discussed conversation storage and context management strategies in [Part 4: Conversation Memory and Context Management](https://www.serverlesslife.com/Building_an_Ecommerce_AI_Agent_with_AWS_Serverless_Part_4_Conversation_Memory_and_Context_Management.html). The sample uses Strands for both instead of implementing its own conversation history serializer.

#### Strands SessionManager with S3

Session handling lives in [strands-agent/AgentService.ts](strands-agent/AgentService.ts#L78-L84). The AG-UI adapter's `sessionManagerProvider` creates a Strands `SessionManager` for each thread, uses the thread ID as the session ID, stores snapshots through `S3Storage`, and saves the latest state on every invocation. The browser sends the current AG-UI run while the server-side session restores the conversation history.

Why S3? It is inexpensive, durable, and accessible from all four runtimes. Consecutive Lambda invocations can land on different environments, and AgentCore runtime sessions expire. Neither should cause the conversation to disappear.

#### Context compaction

**The agent uses [SummarizingConversationManager](strands-agent/AgentService.ts#L87-L93) with proactive compression enabled.** The manager is created per thread through `threadAgentConfig`, so conversation-manager state is not shared between threads.

The sample explicitly sets [`contextWindowLimit` to 131,072 tokens](strands-agent/AgentService.ts#L51-L57) for gpt-oss-20b. As the conversation approaches the model's context limit, proactive compression allows Strands to summarize older context before a model call fails because the context is too large.

### Connecting the browser with AG-UI

[Part 5: Agent–User Interaction Protocol (AG-UI)](https://www.serverlesslife.com/Building_an_Ecommerce_AI_Agent_with_AWS_Serverless_Part_5_Connecting_the_Agent_to_Your_Webshop.html#agent-user-interaction-protocol-ag-ui-) explains how AG-UI streams structured agent events and supports browser-side tool execution.

#### Frontend and example hosting page

The [React chat widget](widget/src/main.tsx) uses CopilotKit v2's `CopilotPopup` and an AG-UI `HttpAgent`. It first mints the demo JWT, then creates the `HttpAgent` with the bearer token, a stable browser thread ID, and the AgentCore session header when that backend requires it. It connects directly to the agent endpoint, without a separate CopilotKit runtime server.

This repository includes an [example HTML page](widget/index.html) that hosts the widget and a small cart. The page exists only to demonstrate integration. On a real webshop, the widget would be embedded into an existing site rather than requiring this example page.

**The sample host also provides a [runtime selector](widget/index.html#L79-L80) so the same frontend can switch between four backends.** [WidgetStack](infra/lib/WidgetStack.ts) publishes the page to an S3 static website and generates `config.js` with the authentication URL, backend URLs, labels, and the AgentCore session-header configuration.

#### Tools executed in the browser

Two frontend tools are registered with CopilotKit's `useFrontendTool`: [add_to_cart and get_cart_content](widget/src/main.tsx#L62-L103). Unlike product search, they run in the customer's browser.

When the model requests a cart action, the call is forwarded through AG-UI. The browser executes the action, and the follow-up run carries its result back to the model. The cart state, UI, and tool handlers share the same React root.

This avoids granting the backend direct access to the webshop cart. The browser can execute an action equivalent to clicking “Add to cart”. In this demo, however, the cart is only in React state and disappears on reload. A production version must connect to the real cart API and validate products and quantities.

### Authentication

Even a public assistant needs protection from unrestricted usage. [Part 6: Authentication](https://www.serverlesslife.com/Building_an_Ecommerce_AI_Agent_with_AWS_Serverless_Part_6_Security_Privacy_and_Observability.html#authentication) explains the authentication approach and security considerations.

The demo's [AuthService](services/AuthService.ts) signs JWTs with an RSA key in AWS KMS. The [authentication Lambda](auth/lambda.ts) exposes a token endpoint, an OpenID Connect discovery document, and JWKS. AgentCore uses its [integrated JWT authorizer](infra/lib/AgentCoreStack.ts#L182-L190), while the Lambda implementations call [verifyJwt()](services/AuthService.ts#L95-L103).

**This is a demonstration of signing and verification, not production user authentication.** The token endpoint deliberately issues tokens without authenticating the caller. A real shop needs an identity provider, rate limits, usage quotas, and abuse protection.

### Deploying the same agent to four runtimes

Each transport uses [AgentService.createChatAgent()](strands-agent/AgentService.ts#L49-L50); only hosting-related code changes. [Part 2: Choosing the Right Runtime](https://www.serverlesslife.com/Building_an_Ecommerce_AI_Agent_with_AWS_Serverless_Part_2_Choosing_the_Right_Runtime.html) compares the performance and cost of these hosting options.

#### Lambda Event Function

The [Lambda handler](lambda-event/handler.ts) validates the token, parses AG-UI input, creates a fresh agent for each invocation, and streams AG-UI events as SSE through `awslambda.streamifyResponse()`. S3 restores history rather than relying on reused Lambda environments. Infrastructure: [AgentLambdaEventStack](infra/lib/AgentLambdaEventStack.ts).

#### Lambda Web Functions

The [Lambda Web Express server](lambda-web/index.ts) listens on the injected `AWS_LAMBDA_HTTP_ENDPOINT` address. `addStrandsExpressEndpoint()` exposes the agent, and Express JWT middleware handles authorization. The server also uses a per-thread agent map only for the lifetime of each request and deletes the entry when the response closes, so a warm environment does not accumulate stale thread agents. Its [CDK stack](infra/lib/AgentLambdaWebStack.ts) uses low-level CloudFormation resources because typed constructs are not yet available in the CDK version used here.

#### AgentCore Runtime V1 and V2

The [AgentCore Express server](agentcore/server.ts) uses the same AG-UI adapter. The [AgentCoreStack](infra/lib/AgentCoreStack.ts) selects V1 or V2 without modifying agent logic, sets a 120-second idle runtime-session timeout and a one-hour maximum lifetime, and enables usage logs to track CPU and memory consumption.

#### Infrastructure with AWS CDK

The [CDK application](infra) contains a [SharedStack](infra/lib/SharedStack.ts) for products, conversation storage, and authentication; one stack per runtime; and a [WidgetStack](infra/lib/WidgetStack.ts) for the example hosting page. Stable CloudFormation exports pass resource names and endpoint URLs between stacks.

### Running the sample

Clone this repository, then run the following commands from its root.

Install dependencies and authenticate using the configured AWS SSO profile:

```bash
npm install
npm run login
```

Deploy and populate the catalogue:

```bash
npm run deploy
npm run seed
```

**Deployment packages the agents, builds the widget, and creates the CDK stacks.** Seeding downloads demo products, generates embeddings on Bedrock, and stores them in DynamoDB. The example page URL is in the CDK outputs. You can switch backends, search for products, and add items to the cart.

**The sample creates billable AWS resources.** Destroy the stacks after experimenting:

```bash
cd infra
npx cdk destroy --all
```

### Performance and cost testing

**This repository also includes the performance and cost testing suite from [Part 2: Price and performance test](https://www.serverlesslife.com/Building_an_Ecommerce_AI_Agent_with_AWS_Serverless_Part_2_Choosing_the_Right_Runtime.html#price-and-performance-test).** It compares latency and infrastructure cost across the four runtimes under different traffic patterns. Methodology, scripts, and results are in the [price-perfomance-test README](price-perfomance-test/README.md).

**This was a small-scale test, so treat the numbers as directional, not exact.** Changes to the agent, its memory requirements, or the time spent talking to the model can shift the results. The exact numbers may differ, but the general trends should be similar.

### Disclaimer

This project is provided for educational and demonstration purposes only. It uses real AWS services, but it is not production-ready. Authentication, security controls, and other features are deliberately simplified.

**You are responsible for reviewing the code, securing your deployment, monitoring charges, and determining suitability for your use.** The code is provided as-is, without warranties. I accept no responsibility for AWS costs, security incidents, data loss, or other damages arising from its use.

### Final thoughts

The sample brings together the components required to operate an AI agent on AWS. The LLM is only one part of the system. Good retrieval, persistent memory, webshop integration, security, and observability matter just as much.

By separating agent logic from transport, we can run the same implementation on Lambda or AgentCore and choose based on measured performance, cost, and operational requirements. The demo is small enough to understand, but it uses real services and exposes the important integration points.

For a new project, I would start with the simplest architecture that meets the requirements, measure how users interact with it, and add complexity only where it is justified. The point of serverless is not to use as many AWS services as possible. It is to build useful applications faster and change direction when we learn something new.

