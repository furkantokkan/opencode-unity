// Canary plugin for opencode-unity tests: if OCU_CANARY_LISTED_PLUGIN_B3F5 appears in a model request, the user's global
// plugins were loaded. It only adds that marker to the system prompt.
export default {
  id: "ocu-canary-listed",
  server: async () => ({
    'experimental.chat.system.transform': async (_input, output) => {
      output.system.push("OCU_CANARY_LISTED_PLUGIN_B3F5");
    },
  }),
};
