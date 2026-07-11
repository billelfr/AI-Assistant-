# Nudgly Product Tools & Stack

## Overview
Nudgly is an AI-powered personal assistant that helps users manage tasks, reminders, WhatsApp conversations, and email through a web dashboard and messaging channels.

## Core Product Tools

### 1. Frontend
- Next.js 16 - App Router for the web application
- React 19 - UI rendering and interactive components
- TypeScript - Type-safe app logic
- Tailwind CSS - Styling and responsive UI

### 2. AI & Agent Layer
- Google Gemini via `@google/genai` - conversational agent and tool-driven reasoning
- Server-side agent routes for chat processing and approval workflows
- Tool-based execution for actions such as task creation, reminders, and notifications

### 3. Data & Authentication
- Supabase - Postgres database, authentication, and real-time subscriptions
- Supabase SSR client - secure server and browser access to auth/session data
- Row-level access patterns for user-specific tasks and chat history

### 4. Communication Tools
- WhatsApp webhook integration - receives and sends messages through WhatsApp
- Nodemailer - sends emails from the app to the user
- Browser notifications - in-dashboard alerts for task and notification updates

### 5. Developer Workflow
- ESLint - linting and code quality checks
- TypeScript compiler - static type validation
- npm scripts for local development and builds

## Main App Areas
- Dashboard UI for chat, tasks, and phone linking
- Agent API endpoint for processing user requests
- Actions API for approval-gated tool execution
- Task email delivery endpoint
- WhatsApp webhook for message ingestion and assistant responses

## Environment Variables
The app expects the following environment values:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `GEMINI_API_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (for admin-style server actions)
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`

## Local Development
Run the app locally with:

```bash
npm install
npm run dev
```

Then open:

```text
http://localhost:3000
```

## Notes
This project is structured around an agent-first workflow where user messages are interpreted by the AI assistant and turned into real actions, rather than just conversational replies.
