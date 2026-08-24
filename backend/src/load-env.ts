import dotenv from 'dotenv';
import { resolve } from 'path';

// Load .env from project root (single .env for both frontend and backend)
dotenv.config({ path: resolve(process.cwd(), '../.env') });