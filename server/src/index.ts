import { SERVER_PORT } from '@frogtato/shared';
import { startServer } from './net.js';

// PORT env override (see net.ts): lets check scripts / secondary instances run
// alongside a live dev server on the default SERVER_PORT without touching it.
const port = Number(process.env.PORT ?? SERVER_PORT);
console.log('[frogtato] shared constants loaded, server port:', port);

startServer();
