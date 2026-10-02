# Using outside Slack

Reaching Company Brain's knowledge from somewhere other than Slack.

In the hosted product, Company Brain spoke MCP: the same permissions graph was reachable from Claude Code, ChatGPT, Cursor, or any MCP client, through supermemory's MCP server.

This self-hosted build now exposes an authenticated, read-only gateway at `/mcp`, with a thin HTTP companion. External agents can search **organization-shared memory** and discover/load **active organization Markdown skills**. They keep their own model, history and execution tools; this is not a public question-answering agent. After deployment/onboarding, an owner/admin can mint expiring, scoped credentials under **Configure → External Access**. See [External-agent access](external-access.md) for first-deployment setup, exact client configuration and the fake-data local demonstration.

## What works today

- **The app UI.** Sign in with Slack on your deployment. The **Graph** page shows the brain's memories (public channel memory plus your own employee memory), following the same [permissions graph](permissions.md) as Slack.
- **The external gateway.** MCP clients with configurable bearer headers, or backend-controlled HTTP clients, can retrieve shared knowledge and organization procedures. No private-channel/employee memory, personal/system skills, writes, OAuth or external actions in v1. Only the MCP SDK client has been tested locally; managed chatbot compatibility is not claimed. External runs are not automatically ingested, and revocation cannot recall downloaded context.
- **A Markdown export.** On **Home**, **Export as Markdown** (next to *Recent memories*) downloads the same memories the Graph shows, public channel memory plus your own employee memory, as one `.md` file: newest first, dated, with their tags. It never includes a teammate's employee memory.
- **Your supermemory account.** Everything the brain remembers lives in the supermemory account your deployment's API key belongs to, under the container tags described in [the permissions graph](permissions.md). supermemory's own tools (its console, API and MCP server) can read that account directly.

> [!WARNING]
> Reading the supermemory account directly is **not** the permissions graph. An API key for that account sees every container: every private channel's memory and every person's employee memory. Treat it as admin-level access and don't hand it to your team as a way to "ask the brain".

Next:

- **[The permissions graph](permissions.md):** what each container tag actually is, and who can read it.
- **[What is Company Brain?](overview.md):** back to the overview.
