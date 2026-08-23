// Clearance Backend - Express Server Entry Point
// Per security.md: Rate limit all endpoints, validate CORS, use secure cookies

import dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(process.cwd(), '../.env') });
import app from './app.js';
import { assertRequiredRuntimeConfig, env } from './config/env.js';

assertRequiredRuntimeConfig();

const PORT = env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[Clearance API] Server running on port ${PORT}`);
  console.log(`[Clearance API] Environment: ${env.NODE_ENV || 'development'}`);
});

export default app;
