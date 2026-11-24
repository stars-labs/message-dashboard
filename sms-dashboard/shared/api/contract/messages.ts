import * as v from 'valibot';
import { MessagePage, MessagesQuery, SendMessageBody, SendMessageResponse } from '../messages.js';
import { PhonesResponse } from '../phones.js';
import { route } from './route.js';

export const messages = {
  phones: route({ kind: 'user', permission: 'phones.read' }, 'GET', '/api/phones').output(
    PhonesResponse,
  ),
  list: route({ kind: 'user', permission: 'messages.read' }, 'GET', '/api/messages')
    .route({ inputStructure: 'detailed' })
    .input(v.object({ query: MessagesQuery }))
    .output(MessagePage),
  send: route({ kind: 'user', permission: 'messages.send' }, 'POST', '/api/messages/send')
    .input(SendMessageBody)
    .output(SendMessageResponse),
};
