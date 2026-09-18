import { Server } from 'colyseus';

const gameServer = new Server();
gameServer.define('lobby', LobbyRoom);
gameServer.define('match', MatchRoom);
gameServer.define('queue', QueueRoom);

export default gameServer;
