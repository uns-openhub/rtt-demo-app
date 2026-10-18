import {
  defineDataCatalogField,
  defineDataCatalogQueryParam,
  defineDataCatalogSchema,
  defineServiceApi,
  type ApiHandler,
  type ServiceApiRegistration,
} from "@uns-kit/api";
import type { MaterialSplitRequest } from "./hrm/hrm-types.js";
import type { HrmProductionLine } from "./hrm/hrm-production-line.js";
import { getBatchById, submitBatch } from "./hrm/services/batch-service.js";
import { getRecipeById, getRecipes, updateRecipe } from "./hrm/services/recipe-service.js";
import { getProductionLineState } from "./hrm/services/status-service.js";
import { z } from "zod";

export type AppApiContext = {
  line: HrmProductionLine;
  processName: string;
};

const hrmServiceRoute = {
  topic: "system",
  asset: "hrm",
  objectType: "service",
} as const;

function getQueryParam(req: { query?: unknown }, key: string): string | null {
  const query = req.query;
  if (!query || typeof query !== "object") {
    return null;
  }

  const value = (query as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

const batchSubmitSchema = defineDataCatalogSchema({
  id: "hrm-batch-submit-request",
  title: "HRM Batch Submit Request",
  contentType: "application/json",
  fields: [
    defineDataCatalogField("recipeId", "string", "Recipe identifier", {
      required: true,
      example: "s355-20mm",
    }),
    defineDataCatalogField("materialId", "string", "Material slab identifier", {
      required: true,
      example: "slab-001",
    }),
    defineDataCatalogField("quantity", "number", "Number of units to produce", {
      required: true,
      example: 1,
    }),
  ],
});

const materialSplitSchema = defineDataCatalogSchema({
  id: 'hrm-material-split-request', title: 'Split completed material', contentType: 'application/json',
  fields: [
    defineDataCatalogField('sourceBatchId', 'string', 'Completed source batch UUID', {required: true}),
    defineDataCatalogField('requestId', 'string', 'Unique command ID; reuse only for the identical request within this simulator run', {required: true}),
    defineDataCatalogField('outputMaterialIds', 'array', 'Exactly two distinct, unused material identifiers; each receives half the source quantity', {required: true}),
  ],
});

const recipeUpdateSchema = defineDataCatalogSchema({
  id: "hrm-recipe-update-request",
  title: "HRM Recipe Update Request",
  contentType: "application/json",
  fields: [
    defineDataCatalogField("targetTempC", "number", "Target furnace temperature", { example: 1200 }),
    defineDataCatalogField("pusherPaceMin", "number", "Pusher pace in minutes", { example: 2.5 }),
    defineDataCatalogField("stoichiometricRatioTarget", "number", "Target stoichiometric ratio", { example: 1.05 }),
    defineDataCatalogField("soakingTimeMin", "number", "Soaking time in minutes", { example: 15 }),
    defineDataCatalogField("zones", "array", "Optional furnace zone setpoints"),
    defineDataCatalogField("zoneId", "integer", "Zone identifier", {
      path: "zones[].zoneId",
      example: 1,
    }),
    defineDataCatalogField("setpointC", "number", "Zone setpoint temperature", {
      path: "zones[].setpointC",
      example: 1180,
    }),
  ],
});

const statusHandler: ApiHandler<"GET", AppApiContext> = async (event, { line }) => {
  event.res.json(getProductionLineState(line));
};

const cassetteMoveRequest = z.object({
  location: z.enum(["stand", "store", "workshop"]),
  expectedRevision: z.number().int().positive(),
  expectedRunId: z.string().uuid(),
}).strict();

const cassetteMoveHandler: ApiHandler<"POST", AppApiContext> = async (event, {line}) => {
  const parsed = cassetteMoveRequest.safeParse(event.req.body);
  if (!parsed.success) {
    event.res.status(400).json({error: "Choose stand, store or workshop and the current cassette revision and run ID."});
    return;
  }
  try {
    event.res.json(line.moveRollCassette(parsed.data.location, parsed.data.expectedRevision, parsed.data.expectedRunId));
  } catch (error) {
    event.res.status(409).json({error: (error as Error).message});
  }
};

const configHandler: ApiHandler<"GET", AppApiContext> = async (event, { line }) => {
  event.res.json(line.getRuntimeConfig());
};

const batchGetHandler: ApiHandler<"GET", AppApiContext> = async (event, { line }) => {
  const batchId = getQueryParam(event.req, "batchId");
  if (!batchId) {
    event.res.status(400).json({ error: "Missing required query parameter: batchId" });
    return;
  }

  const result = getBatchById(line, batchId);
  if (!result.ok) {
    event.res.status(404).json({ error: result.error });
    return;
  }

  event.res.json(result.value);
};

const batchPostHandler: ApiHandler<"POST", AppApiContext> = async (event, { line }) => {
  const result = submitBatch(line, event.req.body as Record<string, unknown> | undefined);
  if (!result.ok) {
    event.res.status(400).json({ error: result.error });
    return;
  }

  event.res.status(result.statusCode).json(result.value);
};

const recipesHandler: ApiHandler<"GET", AppApiContext> = async (event, { line }) => {
  event.res.json({ recipes: getRecipes(line) });
};

const recipeGetHandler: ApiHandler<"GET", AppApiContext> = async (event, { line }) => {
  const recipeId = getQueryParam(event.req, "recipeId");
  if (!recipeId) {
    event.res.status(400).json({ error: "Missing required query parameter: recipeId" });
    return;
  }

  const result = getRecipeById(line, recipeId);
  if (!result.ok) {
    event.res.status(404).json({ error: result.error });
    return;
  }

  event.res.json(result.value);
};

const recipePostHandler: ApiHandler<"POST", AppApiContext> = async (event, { line }) => {
  const recipeId = getQueryParam(event.req, "recipeId");
  if (!recipeId) {
    event.res.status(400).json({ error: "Missing required query parameter: recipeId" });
    return;
  }

  const result = updateRecipe(line, recipeId, event.req.body as Record<string, unknown> | undefined);
  if (!result.ok) {
    event.res.status(400).json({ error: result.error });
    return;
  }

  event.res.json(result.value);
};

const reviewedActionHandler:ApiHandler<'POST',AppApiContext>=async(event,{line})=>{
 try{event.res.json(await line.executeReviewedAction(event.req.body));}catch{event.res.status(409).json({error:'Reviewed Action was rejected or its result is unknown. Refresh lifecycle status and retain the operation ID.'});}
};
const reviewedAdoptionHandler:ApiHandler<'POST',AppApiContext>=async(event,{line})=>{
 try{event.res.json(await line.adoptReviewedLifecycle(event.req.body));}catch{event.res.status(409).json({error:'Reviewed successor adoption was rejected or its result is unknown. Refresh status and retain the operation ID.'});}
};
const reviewedResultHandler:ApiHandler<'GET',AppApiContext>=async(event,{line})=>{
 const id=getQueryParam(event.req,'operationId');if(!id||!z.string().uuid().safeParse(id).success){event.res.status(400).json({error:'An operation ID is required.'});return;}
 try{event.res.json({result:line.reviewedActionResult(id),lifecycle:line.getState().reviewedLifecycle});}catch{event.res.status(409).json({error:'Reviewed lifecycle is not configured.'});}
};
const reviewedClosureHandler:ApiHandler<'POST',AppApiContext>=async(event,{line})=>{try{event.res.json(await line.closeReviewedAdoption(event.req.body));}catch{event.res.status(409).json({error:'Closure was rejected or its outcome is unknown. Retain the saved request and check its original operation result.'});}};
const splitMaterialHandler: ApiHandler<'POST', AppApiContext> = async (event, {line}) => {
  const result = line.splitMaterial(event.req.body as MaterialSplitRequest);
  if (!result.ok) { event.res.status(result.statusCode).json({error: result.error}); return; }
  event.res.json(result.value);
};

export const serviceApis = {
  reviewedClosure:defineServiceApi({...hrmServiceRoute,attribute:'reviewed-lifecycle-close',method:'POST',description:'Durably close a pending adoption, preserving state and blocking late delivery',tags:['hrm'],handler:reviewedClosureHandler}),
  reviewedAction:defineServiceApi({...hrmServiceRoute,attribute:'reviewed-lifecycle-action',method:'POST',description:'Execute an explicitly pinned reviewed demo state/Action contract',tags:['hrm'],handler:reviewedActionHandler}),
  reviewedAdoption:defineServiceApi({...hrmServiceRoute,attribute:'reviewed-lifecycle-adopt',method:'POST',description:'Explicitly adopt the direct reviewed successor without resetting state',tags:['hrm'],handler:reviewedAdoptionHandler}),
  reviewedResult:defineServiceApi({...hrmServiceRoute,attribute:'reviewed-lifecycle-result',method:'GET',description:'Recover a durable demo operation result without executing again',tags:['hrm'],handler:reviewedResultHandler}),
  moveRollCassette: defineServiceApi({
    ...hrmServiceRoute, attribute: "roll-cassette", method: "POST",
    description: "Move the simulated roll cassette and its two work rolls while the stand is empty",
    tags: ["hrm"],
    requestBody: {required: true, contentType: "application/json", schemas: [defineDataCatalogSchema({
      id: "hrm-roll-cassette-move", title: "Move roll cassette", contentType: "application/json",
      fields: [
        defineDataCatalogField("location", "string", "Destination: stand, store or workshop", {required: true}),
        defineDataCatalogField("expectedRevision", "integer", "Current cassette revision from status", {required: true}),
        defineDataCatalogField("expectedRunId", "string", "Simulator run ID from status", {required: true}),
      ],
    })]},
    handler: cassetteMoveHandler,
  }),
  status: defineServiceApi({
    ...hrmServiceRoute,
    attribute: "status",
    method: "GET",
    description: "HRM production line status - all stations, queue, completed batches",
    tags: ["hrm"],
    handler: statusHandler,
  }),
  config: defineServiceApi({
    ...hrmServiceRoute,
    attribute: "config",
    method: "GET",
    description: "HRM simulator runtime config needed by external services",
    tags: ["hrm"],
    handler: configHandler,
  }),
  batch: defineServiceApi({
    ...hrmServiceRoute,
    attribute: "batch",
    method: "GET",
    description: "HRM batch details - query by batchId using ?batchId=...",
    tags: ["hrm"],
    queryParams: [
      defineDataCatalogQueryParam("batchId", "HRM batch identifier", {
        required: true,
      }),
    ],
    handler: batchGetHandler,
  }),
  submitBatch: defineServiceApi({
    ...hrmServiceRoute,
    attribute: "batch",
    method: "POST",
    description: "Submit a new batch to the HRM production line",
    tags: ["hrm"],
    requestBody: {
      required: true,
      description: "Batch submission payload",
      contentType: "application/json",
      schemas: [batchSubmitSchema],
    },
    handler: batchPostHandler,
  }),
  splitMaterial: defineServiceApi({
    ...hrmServiceRoute, attribute: 'material-split', method: 'POST',
    description: 'Split one completed material into two new warehouse outputs; repeat the same requestId for a known result within this simulator run.',
    tags: ['hrm'],
    requestBody: {required: true, contentType: 'application/json', description: 'Split a completed source without repeating production', schemas: [materialSplitSchema]},
    handler: splitMaterialHandler,
  }),
  recipes: defineServiceApi({
    ...hrmServiceRoute,
    attribute: "recipe-map",
    method: "GET",
    description: "HRM recipe map - list all simulator recipes",
    tags: ["hrm"],
    handler: recipesHandler,
  }),
  recipe: defineServiceApi({
    ...hrmServiceRoute,
    attribute: "recipe",
    method: "GET",
    description: "HRM recipe detail - query by recipeId using ?recipeId=...",
    tags: ["hrm"],
    queryParams: [
      defineDataCatalogQueryParam("recipeId", "HRM recipe identifier", {
        required: true,
      }),
    ],
    handler: recipeGetHandler,
  }),
  updateRecipe: defineServiceApi({
    ...hrmServiceRoute,
    attribute: "recipe",
    method: "POST",
    description: "Update an HRM recipe in-memory for queued/active batches using ?recipeId=...",
    tags: ["hrm"],
    queryParams: [
      defineDataCatalogQueryParam("recipeId", "HRM recipe identifier", {
        required: true,
      }),
    ],
    requestBody: {
      required: true,
      description: "Partial furnace recipe update payload",
      contentType: "application/json",
      schemas: [recipeUpdateSchema],
    },
    handler: recipePostHandler,
  }),
} satisfies Record<string, ServiceApiRegistration>;
