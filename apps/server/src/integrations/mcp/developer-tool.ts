import { z } from 'zod';
import { additiveTools, externalTools } from './annotations.js';
import type { IntegrationPrincipal, IntegrationScope } from '../auth/index.js';
import type { IntegrationTool, ToolRisk } from './catalog.js';

export type DeveloperResult = { ok: true; version: 'v2'; value: unknown } | { ok: false; version: 'v2'; error: { code: string; message: string; retryable: boolean } };
export type DeveloperTool = IntegrationTool & {
  audiences: readonly ('conductor' | 'realtime')[];
  contractVersion?: 'v1' | 'v2';
  output: z.ZodTypeAny;
  idempotency?: 'generic' | 'domain_cursor' | 'lifecycle';
  execute: (input: Record<string, unknown>, principal: IntegrationPrincipal) => Promise<DeveloperResult>;
};
export type DeveloperToolInput = Omit<DeveloperTool, 'annotations' | 'outputSchema' | 'feature'> & {
  dataSchema: Record<string, unknown>;
  openWorld?: boolean;
  destructive?: boolean;
};

// retain strict paired schemas without introducing a schema conversion language
export function developerTool(input: DeveloperToolInput): DeveloperTool {
  const { dataSchema, openWorld = externalTools.has(input.name), destructive = input.risk !== 'read' && !additiveTools.has(input.name), ...definition } = input;
  const { $defs: definitions, ...data } = dataSchema;
  const error = { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, retryable: { type: 'boolean' } }, required: ['code', 'message', 'retryable'], additionalProperties: false };
  const common = { contract_version: { const: input.contractVersion ?? 'v2' }, correlation_id: { type: 'string' }, replayed: { type: 'boolean' } };
  return {
    ...definition,
    inputSchema: { type: 'object', ...instanceInput(definition.inputSchema) },
    feature: input.risk === 'read' ? 'read' : input.risk === 'dangerous' ? 'dangerous' : 'write',
    outputSchema: { type: 'object', ...(definitions === undefined ? {} : { $defs: definitions }), oneOf: [
      { type: 'object', properties: { ...common, ok: { const: true }, data }, required: ['ok', 'contract_version', 'correlation_id', 'data'], additionalProperties: false },
      { type: 'object', properties: { ...common, ok: { const: false }, error }, required: ['ok', 'contract_version', 'correlation_id', 'error'], additionalProperties: false }
    ] },
    annotations: { readOnlyHint: input.risk === 'read', destructiveHint: destructive, idempotentHint: input.risk === 'read' || input.idempotency === 'domain_cursor', openWorldHint: openWorld }
  };
}

// project the optional transport selector into each exact top-level input arm
function instanceInput(schema: Record<string, unknown>): Record<string, unknown> {
  const result = { ...schema };
  // object-arm restrictions must admit the selector that the gateway removes before Zod
  if (schema.properties !== undefined) result.properties = { instance_id: { type: 'string', minLength: 1, maxLength: 240, pattern: '^[^\\u0000]*$' }, ...(schema.properties as Record<string, unknown>) };
  // discriminated input unions keep their closed-object arms
  if (Array.isArray(schema.oneOf)) result.oneOf = schema.oneOf.map(arm => instanceInput(arm as Record<string, unknown>));
  return result;
}

// construct one bounded developer-operation success
export function developerSuccess(value: unknown): DeveloperResult { return { ok: true, version: 'v2', value }; }

// construct one truthful developer-operation refusal
export function developerFailure(code: string, message: string, retryable = false): DeveloperResult { return { ok: false, version: 'v2', error: { code, message, retryable } }; }

export const developerIdentifier = z.string().min(1).max(240).refine(value => !value.includes('\0'));
export const developerIdSchema = { type: 'string', minLength: 1, maxLength: 240, pattern: '^[^\\u0000]*$' };
export const developerRequestId = z.string().min(8).max(200);
export const developerRequestSchema = { type: 'string', minLength: 8, maxLength: 200 };
export const developerPageShape = { cursor: z.string().min(1).max(400).optional(), limit: z.number().int().min(1).max(100).optional() };
export const developerPageProperties = { cursor: { type: 'string', minLength: 1, maxLength: 400 }, limit: { type: 'integer', minimum: 1, maximum: 100 } };
export type DeveloperAudience = 'conductor' | 'realtime';
export type DeveloperScopes = IntegrationScope[];
export type DeveloperRisk = ToolRisk;
