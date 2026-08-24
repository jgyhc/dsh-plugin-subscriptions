/**
 * Answer Cursor `interaction_query` frames so an AgentService/Run stream
 * does not stall on hosted web-search / web-fetch permission prompts.
 *
 * Ported from oh-my-pi (MIT): packages/ai/src/providers/cursor/interaction-query.ts
 */

import type http2 from 'node:http2'
import {
  AgentClientMessageSchema,
  AskQuestionInteractionResponseSchema,
  AskQuestionRejectedSchema,
  AskQuestionResultSchema,
  CreatePlanErrorSchema,
  CreatePlanRequestResponseSchema,
  CreatePlanResultSchema,
  ExaFetchRequestResponse_ApprovedSchema,
  ExaFetchRequestResponseSchema,
  ExaSearchRequestResponse_ApprovedSchema,
  ExaSearchRequestResponseSchema,
  type InteractionQuery,
  type InteractionResponse,
  InteractionResponseSchema,
  SwitchModeRequestResponse_RejectedSchema,
  SwitchModeRequestResponseSchema,
  WebFetchRequestResponse_ApprovedSchema,
  WebFetchRequestResponseSchema,
  WebSearchRequestResponse_ApprovedSchema,
  WebSearchRequestResponseSchema,
} from '../providers/cursor-proto/cursor-proto.js'
import { create, toBinary } from '../providers/cursor-proto/protobuf.js'
import { frameConnectMessage } from './cursor-wire.js'

const NOT_IMPLEMENTED_SUFFIX = 'not implemented by this client'

type ProtoUnknownField = { no: number; wireType: number; data: Uint8Array }
type ProtoUnknownBag = { $unknown?: ProtoUnknownField[] }

type InteractionQueryCase = NonNullable<InteractionQuery['query']['case']>
type InteractionResult = Exclude<InteractionResponse['result'], { case: undefined; value?: undefined }>

function isProtoUnknownField(value: unknown): value is ProtoUnknownField {
  if (value === null || typeof value !== 'object') return false
  if (!('no' in value) || !('wireType' in value) || !('data' in value)) return false
  return typeof value.no === 'number' && typeof value.wireType === 'number' && value.data instanceof Uint8Array
}

function protoUnknownFields(message: object): ProtoUnknownField[] {
  if (!('$unknown' in message) || !Array.isArray(message.$unknown)) return []
  return message.$unknown.filter(isProtoUnknownField)
}

function attachUnknownApprovedField(response: InteractionResponse, fieldNo: number): void {
  const bag: ProtoUnknownBag = response
  const field: ProtoUnknownField = { no: fieldNo, wireType: 2, data: new Uint8Array([0x02, 0x0a, 0x00]) }
  const existing = bag.$unknown
  if (Array.isArray(existing)) {
    existing.push(field)
    return
  }
  bag.$unknown = [field]
}

function sendInteractionResponse(
  h2Request: http2.ClientHttp2Stream,
  queryId: number,
  result: InteractionResult,
): void {
  const response = create(InteractionResponseSchema, { id: queryId, result })
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: 'interactionResponse', value: response },
  })
  h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)))
}

function sendUnknownApprovedInteractionResponse(
  h2Request: http2.ClientHttp2Stream,
  queryId: number,
  fieldNo: number,
): void {
  const response = create(InteractionResponseSchema, { id: queryId })
  attachUnknownApprovedField(response, fieldNo)
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: 'interactionResponse', value: response },
  })
  h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)))
}

/** Auto-approve or reject Cursor permission / interactive queries. */
export function handleInteractionQuery(query: InteractionQuery, h2Request: http2.ClientHttp2Stream): void {
  const queryCase = query.query.case
  if (queryCase === undefined) {
    const unknown = protoUnknownFields(query).find(field => field.wireType === 2 && field.no >= 2)
    if (unknown !== undefined) {
      sendUnknownApprovedInteractionResponse(h2Request, query.id, unknown.no)
    }
    return
  }

  switch (queryCase) {
    case 'webSearchRequestQuery':
      sendInteractionResponse(h2Request, query.id, {
        case: 'webSearchRequestResponse',
        value: create(WebSearchRequestResponseSchema, {
          result: { case: 'approved', value: create(WebSearchRequestResponse_ApprovedSchema, {}) },
        }),
      })
      return
    case 'exaSearchRequestQuery':
      sendInteractionResponse(h2Request, query.id, {
        case: 'exaSearchRequestResponse',
        value: create(ExaSearchRequestResponseSchema, {
          result: { case: 'approved', value: create(ExaSearchRequestResponse_ApprovedSchema, {}) },
        }),
      })
      return
    case 'exaFetchRequestQuery':
      sendInteractionResponse(h2Request, query.id, {
        case: 'exaFetchRequestResponse',
        value: create(ExaFetchRequestResponseSchema, {
          result: { case: 'approved', value: create(ExaFetchRequestResponse_ApprovedSchema, {}) },
        }),
      })
      return
    case 'webFetchRequestQuery':
      sendInteractionResponse(h2Request, query.id, {
        case: 'webFetchRequestResponse',
        value: create(WebFetchRequestResponseSchema, {
          result: { case: 'approved', value: create(WebFetchRequestResponse_ApprovedSchema, {}) },
        }),
      })
      return
    case 'askQuestionInteractionQuery':
      sendInteractionResponse(h2Request, query.id, {
        case: 'askQuestionInteractionResponse',
        value: create(AskQuestionInteractionResponseSchema, {
          result: create(AskQuestionResultSchema, {
            result: {
              case: 'rejected',
              value: create(AskQuestionRejectedSchema, {
                reason: `Interactive questions are ${NOT_IMPLEMENTED_SUFFIX}`,
              }),
            },
          }),
        }),
      })
      return
    case 'switchModeRequestQuery':
      sendInteractionResponse(h2Request, query.id, {
        case: 'switchModeRequestResponse',
        value: create(SwitchModeRequestResponseSchema, {
          result: {
            case: 'rejected',
            value: create(SwitchModeRequestResponse_RejectedSchema, {
              reason: `Mode switches are ${NOT_IMPLEMENTED_SUFFIX}`,
            }),
          },
        }),
      })
      return
    case 'createPlanRequestQuery':
      sendInteractionResponse(h2Request, query.id, {
        case: 'createPlanRequestResponse',
        value: create(CreatePlanRequestResponseSchema, {
          result: create(CreatePlanResultSchema, {
            result: {
              case: 'error',
              value: create(CreatePlanErrorSchema, {
                error: `Plan files are ${NOT_IMPLEMENTED_SUFFIX}`,
              }),
            },
          }),
        }),
      })
      return
    case 'setupVmEnvironmentArgs':
      return
    default: {
      const _exhaustive: InteractionQueryCase = queryCase
      void _exhaustive
    }
  }
}
