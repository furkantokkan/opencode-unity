import Fastify from 'fastify';

const app = Fastify();

app.get('/health', async () => ({ ok: true }));
app.post('/scores', async () => ({ accepted: true }));
app.get('/seasons/:id', async () => ({ id: 1 }));

export default app;
