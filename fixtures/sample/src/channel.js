export const sent = [];

export function send(message) {
  return sent.push(message);
}

