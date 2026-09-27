import { tool } from "langchain";
import { z } from "zod";

export const contextSchema = z.object({ userId: z.string().min(1) });

export const getWeather = tool(
  async ({ city }, runtime) => {
    // Replace with the application's weather integration. Context is provided
    // by the trusted server request, not by the model or request body.
    console.info(`Weather requested by ${runtime.context.userId}: ${city}`);
    return { city, forecast: "Sunny" };
  },
  {
    name: "get_weather",
    description: "Get the current weather for a city.",
    schema: z.object({ city: z.string().min(1) }),
  },
);

export const sendEmail = tool(
  async ({ to, body }, runtime) => {
    // This demo logs the side effect. Replace it with the application's mailer
    // and authorize the recipient against runtime.context.userId.
    console.info("Approved email delivery", {
      userId: runtime.context.userId,
      to,
      body,
    });
    return { recorded: true };
  },
  {
    name: "send_email",
    description: "Send an email after the user approves it.",
    schema: z.object({
      to: z.string().email(),
      body: z.string().min(1).max(20_000),
    }),
  },
);
