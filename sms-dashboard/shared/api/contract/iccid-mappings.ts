import * as v from 'valibot';
import {
  CreateIccidMappingBody,
  CreateIccidMappingResponse,
  DeleteIccidMappingResponse,
  IccidMappingDetailResponse,
  IccidMappingsQuery,
  IccidMappingsResponse,
  UpdateIccidMappingBody,
  UpdateIccidMappingResponse,
} from '../iccid-mappings.js';
import { route } from './route.js';

const Id = v.object({ id: v.string() });

export const iccidMappings = {
  list: route({ kind: 'user', permission: 'phones.read' }, 'GET', '/api/iccid-mappings')
    .route({ inputStructure: 'detailed' })
    .input(v.object({ query: IccidMappingsQuery }))
    .output(IccidMappingsResponse),
  get: route({ kind: 'user', permission: 'phones.read' }, 'GET', '/api/iccid-mappings/{id}')
    .route({ inputStructure: 'detailed' })
    .input(v.object({ params: Id }))
    .output(IccidMappingDetailResponse),
  // 201 when the SIM is new, 200 when the write updated one that existed.
  create: route({ kind: 'user', permission: 'phones.write' }, 'POST', '/api/iccid-mappings')
    .route({ outputStructure: 'detailed' })
    .input(CreateIccidMappingBody)
    .output(
      v.union([
        v.object({ status: v.literal(201), body: CreateIccidMappingResponse }),
        v.object({ status: v.literal(200), body: CreateIccidMappingResponse }),
      ]),
    ),
  update: route({ kind: 'user', permission: 'phones.write' }, 'PUT', '/api/iccid-mappings/{id}')
    .route({ inputStructure: 'detailed' })
    .input(v.object({ params: Id, body: UpdateIccidMappingBody }))
    .output(UpdateIccidMappingResponse),
  remove: route({ kind: 'user', permission: 'phones.write' }, 'DELETE', '/api/iccid-mappings/{id}')
    .route({ inputStructure: 'detailed' })
    .input(v.object({ params: Id }))
    .output(DeleteIccidMappingResponse),
};
