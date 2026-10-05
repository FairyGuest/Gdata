import { send } from './channel.js';

export function notify(message) {
  send(message);
  return true;
}

