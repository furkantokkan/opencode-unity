import express from 'express';

const app = express();
app.get('/health', (_request, response) => response.json({ ok: true }));
app.post('/scores', (_request, response) => response.json({ accepted: true }));
app.use('/seasons', seasonRouter);

export default app;
