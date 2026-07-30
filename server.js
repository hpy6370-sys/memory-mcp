import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Database (must be imported first to init tables before tools register)
import "./db.js";

// v2 schema migration (adds new tables/columns, safe to run multiple times)
import "./v2/index.js";

// Tool registrations
import { registerWriteTool } from "./tools/write.js";
import { registerReadTool } from "./tools/read.js";
import { registerSearchTool } from "./tools/search.js";
import { registerSurfaceTool } from "./tools/surface.js";
import { registerUpdateTool } from "./tools/update.js";
import { registerDeleteTool } from "./tools/delete.js";
import { registerUserModelTools } from "./tools/user_model.js";
import { registerLearningTools } from "./tools/learning.js";
import { registerReactTools } from "./tools/react.js";
import { registerFileIndexTools } from "./tools/file_index_v2.js";

const server = new McpServer({ name: "memory", version: "3.0.0-alpha" });

// Register all tools
registerWriteTool(server);
registerReadTool(server);
registerSearchTool(server);
registerSurfaceTool(server);
registerUpdateTool(server);
registerDeleteTool(server);
registerUserModelTools(server);
registerLearningTools(server);
registerReactTools(server);
registerFileIndexTools(server);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
