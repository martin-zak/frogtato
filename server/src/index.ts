import { SERVER_PORT } from '@frogtato/shared';
import { startServer } from './net.js';

console.log('[frogtato] shared constants loaded, server port:', SERVER_PORT);

startServer();
