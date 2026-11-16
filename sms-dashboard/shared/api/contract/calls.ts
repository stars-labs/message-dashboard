import * as v from 'valibot';
import {
  AnswerBody,
  CallConnectResponse,
  CallHangupResponse,
  CallHistoryQuery,
  CallHistoryResponse,
  CallIdBody,
  CallMediaResponse,
  CallRenegotiateResponse,
  CallStateResponse,
  DialBody,
  IceServersResponse,
  RenegotiateBody,
} from '../calls.js';
import { route } from './route.js';

/** Whoever may read SMS may call. */
const CALLER = { kind: 'user', permission: 'messages.read' } as const;

/** Voice calls from the dashboard, through the Realtime SFU to a modem on the Pi. */
export const calls = {
  state: route(CALLER, 'GET', '/api/calls/state').output(CallStateResponse),
  history: route(CALLER, 'GET', '/api/calls/history')
    .route({ inputStructure: 'detailed' })
    .input(v.object({ query: CallHistoryQuery }))
    .output(CallHistoryResponse),
  ice: route(CALLER, 'GET', '/api/calls/ice').output(IceServersResponse),
  dial: route(CALLER, 'POST', '/api/calls/dial').input(DialBody).output(CallMediaResponse),
  answer: route(CALLER, 'POST', '/api/calls/answer').input(AnswerBody).output(CallMediaResponse),
  connect: route(CALLER, 'POST', '/api/calls/connect')
    .input(CallIdBody)
    .output(CallConnectResponse),
  renegotiate: route(CALLER, 'POST', '/api/calls/renegotiate')
    .input(RenegotiateBody)
    .output(CallRenegotiateResponse),
  hangup: route(CALLER, 'POST', '/api/calls/hangup').input(CallIdBody).output(CallHangupResponse),
};
