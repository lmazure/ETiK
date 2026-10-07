import { z } from "zod";
import { batchArgs, editArgs, moveArgs, restoreArgs, searchArgs, tools, writeArgs } from "../schemas.js";

const json = (schema: z.ZodType) => z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });

const jsonBody = (schema: z.ZodType) => ({ required: true, content: { "application/json": { schema: json(schema) } } });

const store = { name: "store", in: "path", required: true, schema: { type: "string" } };
const docPath = {
  name: "path", in: "path", required: true, schema: { type: "string" },
  description: "Document path without its leading '/', e.g. entities/requirement.md",
};
const query = (name: string, type: string, description?: string) =>
  ({ name, in: "query", required: false, schema: { type }, ...(description && { description }) });
const header = (name: string, description: string) =>
  ({ name, in: "header", required: false, schema: { type: "string" }, description });

const session = header("X-Memory-Session", "Session recorded in the history of each change.");
const ifMatch = header("If-Match", "Expected current version, e.g. \"7\"; 412 if it differs.");

const ok = (description: string) => ({ description, content: { "application/json": { schema: { type: "object" } } } });
const errors = {
  "400": { $ref: "#/components/responses/Error" },
  "401": { $ref: "#/components/responses/Error" },
  "403": { $ref: "#/components/responses/Error" },
  "404": { $ref: "#/components/responses/Error" },
};

/** OpenAPI 3.1 description of `/api`, generated from the same schemas as the MCP tools. */
export function openApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "ETiK memory API",
      version: "0.1.0",
      description: "Versioned document memory. Each operation mirrors one MCP tool; the rules are the same.",
    },
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      responses: {
        Error: {
          description: "Error",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: {
                    type: "object",
                    properties: { code: { type: "string" }, message: { type: "string" }, details: { type: "object" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    security: [{ bearer: [] }],
    paths: {
      "/api/stores": {
        get: { summary: "List stores (admin)", responses: { "200": ok("Stores"), ...errors } },
      },
      "/api/stores/{store}/list": {
        get: {
          summary: tools.memory_list.description,
          parameters: [store, session, query("path", "string"), query("depth", "integer"),
            query("tags", "string", "Comma-separated"), query("limit", "integer"), query("offset", "integer")],
          responses: { "200": ok("Listing"), ...errors },
        },
      },
      "/api/stores/{store}/docs/{path}": {
        get: {
          summary: tools.memory_read.description,
          parameters: [store, docPath, session, query("section", "string"), query("from", "integer"),
            query("to", "integer", "-1 means end of document"), query("version", "integer")],
          responses: { "200": ok("Document, with ETag header"), ...errors },
        },
        put: {
          summary: tools.memory_write.description,
          parameters: [store, docPath, session, ifMatch,
            header("If-None-Match", "'*' to create; without it the document is overwritten and must exist.")],
          requestBody: jsonBody(writeArgs.omit({ path: true, mode: true, if_version: true })),
          responses: { "200": ok("Overwritten"), "201": ok("Created"), "409": { $ref: "#/components/responses/Error" },
            "412": { $ref: "#/components/responses/Error" }, ...errors },
        },
        patch: {
          summary: tools.memory_edit.description,
          parameters: [store, docPath, session, ifMatch],
          requestBody: jsonBody(editArgs.omit({ path: true })),
          responses: { "200": ok("Edited"), "412": { $ref: "#/components/responses/Error" },
            "422": { $ref: "#/components/responses/Error" }, ...errors },
        },
        delete: {
          summary: tools.memory_delete.description,
          parameters: [store, docPath, session, ifMatch, query("recursive", "boolean"), query("change_note", "string")],
          responses: { "200": ok("Deleted"), "409": { $ref: "#/components/responses/Error" }, ...errors },
        },
      },
      "/api/stores/{store}/search": {
        post: { summary: tools.memory_search.description, parameters: [store, session], requestBody: jsonBody(searchArgs),
          responses: { "200": ok("Hits"), "501": { $ref: "#/components/responses/Error" }, ...errors } },
      },
      "/api/stores/{store}/move": {
        post: { summary: tools.memory_move.description, parameters: [store, session], requestBody: jsonBody(moveArgs),
          responses: { "200": ok("Moved"), "409": { $ref: "#/components/responses/Error" }, ...errors } },
      },
      "/api/stores/{store}/batch": {
        post: { summary: tools.memory_batch.description, parameters: [store, session], requestBody: jsonBody(batchArgs),
          responses: { "200": ok("All operations applied"), ...errors } },
      },
      "/api/stores/{store}/history/{path}": {
        get: { summary: tools.memory_history.description, parameters: [store, docPath, query("limit", "integer")],
          responses: { "200": ok("Versions, newest first"), ...errors } },
      },
      "/api/stores/{store}/deleted": {
        get: { summary: "List deleted documents (admin)", parameters: [store], responses: { "200": ok("Deleted documents"), ...errors } },
      },
      "/api/stores/{store}/restore": {
        post: { summary: "Restore a deleted document (admin)", parameters: [store, session], requestBody: jsonBody(restoreArgs),
          responses: { "200": ok("Restored"), "409": { $ref: "#/components/responses/Error" }, ...errors } },
      },
    },
  };
}
