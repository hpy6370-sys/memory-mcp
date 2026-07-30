// Local model interface — calls Ollama memory-v2 (our fine-tuned Qwen2.5-1.5B)
const OLLAMA_URL = "http://localhost:11434/api/generate";
const MODEL = "memory-v2";

export async function callLocalModel(prompt, { temperature = 0.3, maxTokens = 512 } = {}) {
  try {
    const resp = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        prompt,
        stream: false,
        options: { temperature, num_predict: maxTokens },
      }),
    });
    const data = await resp.json();
    return data.response || "";
  } catch (e) {
    return "";
  }
}

export async function extractMemories(conversation) {
  const prompt = `From this conversation, extract important facts worth remembering as a JSON array of strings in first person. Only include genuinely new information.\n\nConversation:\n${conversation.slice(0, 2000)}\n\nExtracted memories (JSON array):`;
  return callLocalModel(prompt);
}

export async function extractLearnings(conversation) {
  const prompt = `From this conversation, extract insights about the user in categories: what(facts), like(preferences), why(motivations), how(behavior), feel(emotions), boundary(limits). Output JSON object.\n\nConversation:\n${conversation.slice(0, 3000)}\n\nInsights (JSON):`;
  return callLocalModel(prompt);
}

export async function analyzeQueryWithModel(message, context = "") {
  const prompt = `Analyze this message. Extract: keywords (array), mood (string or null), temporal (boolean). Output JSON.\n\n${context ? `Context: ${context}\n\n` : ""}Message: ${message}\n\nAnalysis (JSON):`;
  return callLocalModel(prompt, { maxTokens: 256 });
}

export async function isModelAvailable() {
  try {
    const resp = await fetch("http://localhost:11434/api/tags");
    const data = await resp.json();
    return data.models?.some(m => m.name.includes("memory-v2")) || false;
  } catch {
    return false;
  }
}
