import { z } from "zod";
import { defineTool } from "../../src/index.js";
import type { AgentContext } from "../../src/index.js";

type WeatherContext = AgentContext & {
  tenantId: string;
};

const weather = defineTool({
  name: "get_weather",
  description: "Look up weather.",
  input: z.object({
    city: z.string(),
    units: z.enum(["metric", "imperial"]).optional(),
  }),
  run: async (input, ctx: WeatherContext) => {
    const cityName: string = input.city;
    const selectedUnits: "metric" | "imperial" | undefined = input.units;
    const tenantId: string = ctx.tenantId;

    // @ts-expect-error The runtime schema does not contain this input field.
    const missing = input.country;
    // @ts-expect-error Schema inference keeps city as a string.
    const invalidCity: number = input.city;
    // @ts-expect-error The custom context keeps tenantId as a string.
    const invalidTenant: number = ctx.tenantId;

    return {
      cityName,
      selectedUnits,
      tenantId,
      missing,
      invalidCity,
      invalidTenant,
    };
  },
});

void weather;
