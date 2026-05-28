// Completions are served via the OpenAI-compat REST routes
// (`routes/openai/chat.ts`), not via oRPC. This file exists as a
// structural placeholder per the feature-module convention. The actual
// HTTP handler lives in `routes/openai/chat.ts` because the OpenAI
// surface has its own auth (bearer), CORS, and error-envelope that
// differ from the oRPC surface.
