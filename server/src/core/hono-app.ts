import { Hono } from "hono";
import type { Env } from "hono";
import type { Variables } from "./hono-types";
import { registerErrorHandlers } from "./error-response";
import { registerMiddlewares } from "./register-middlewares";
import { registerRoutes } from "./register-routes";

export function createHonoApp(): Hono<{
    Bindings: Env;
    Variables: Variables;
}> {
    const app = new Hono<{
        Bindings: Env;
        Variables: Variables;
    }>();

    registerMiddlewares(app);
    // CORS: allow cross-origin from Pages frontend
    app.use("*", async (c, next) => {
        c.header("Access-Control-Allow-Origin", "*");
        c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
        c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
        c.header("Access-Control-Max-Age", "86400");
        if (c.req.method === "OPTIONS") {
            return new Response(null, { status: 204 });
        }
        await next();
    });
    registerRoutes(app);
    registerErrorHandlers(app);

    return app;
}

