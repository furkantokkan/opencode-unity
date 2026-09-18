import { onCall, onRequest } from 'firebase-functions/v2/https';

export const health = onRequest((_request, response) => {
  response.send('ok');
});

export const claimReward = onCall(async () => ({ granted: true }));

export const submitScore = onCall(async () => ({ accepted: true }));
