import { GoogleGenAI, Type } from "@google/genai";
import { MindMapData } from "../types";

const apiKey = process.env.GEMINI_API_KEY || "";

export async function extractMindMap(text: string): Promise<MindMapData> {
  if (!apiKey) {
    throw new Error("Gemini API Key is missing. Please add GEMINI_API_KEY to your secrets.");
  }
  
  const ai = new GoogleGenAI({ apiKey });
  const model = "gemini-3-flash-preview";
  
  try {
    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Extract a comprehensive mind map from the following text. 
              Identify the central theme (root), main concepts (main), and sub-concepts (sub).
              Ensure all nodes are connected logically.
              
              Text to analyze:
              ${text}`
            }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            nodes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING, description: "Unique identifier for the node" },
                  label: { type: Type.STRING, description: "Short, descriptive label for the concept" },
                  description: { type: Type.STRING, description: "Brief explanation of the concept" },
                  type: { 
                    type: Type.STRING,
                    enum: ["root", "main", "sub"],
                    description: "Hierarchy level of the concept"
                  }
                },
                required: ["id", "label", "type"]
              }
            },
            edges: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  source: { type: Type.STRING, description: "ID of the parent node" },
                  target: { type: Type.STRING, description: "ID of the child node" },
                  label: { type: Type.STRING, description: "Relationship description" }
                },
                required: ["id", "source", "target"]
              }
            }
          },
          required: ["nodes", "edges"]
        }
      }
    });

    if (!response.text) {
      throw new Error("Empty response from AI model");
    }

    let result;
    try {
      // Clean the response text in case there's any markdown wrapping
      const cleanedText = response.text.trim().replace(/^```json\n?/, '').replace(/\n?```$/, '');
      result = JSON.parse(cleanedText);
    } catch (e) {
      console.error("JSON Parse Error. Raw text:", response.text);
      throw new Error("Failed to parse AI response as JSON");
    }
    
    if (!result.nodes || !Array.isArray(result.nodes) || result.nodes.length === 0) {
      throw new Error("AI returned no concepts for this text");
    }
    
    // Initialize positions (will be refined by layout logic)
    const nodes = result.nodes.map((node: any, index: number) => ({
      ...node,
      x: 400 + (Math.random() - 0.5) * 200,
      y: 300 + (Math.random() - 0.5) * 200,
      color: getNodeColor(node.type)
    }));

    return {
      nodes,
      edges: result.edges || []
    };
  } catch (error: any) {
    console.error("Gemini API Error:", error);
    throw error;
  }
}

export async function expandConcept(concept: string, context: string): Promise<{ 
  text: string; 
  links?: { uri: string; title: string }[];
  trendingQueries?: string[];
}> {
  if (!apiKey) {
    throw new Error("Gemini API Key is missing.");
  }
  
  const ai = new GoogleGenAI({ apiKey });
  const model = "gemini-3-flash-preview";
  
  const truncatedContext = context.length > 2000 ? context.substring(0, 2000) + "..." : context;
  
  async function attemptExpansion(useSearch: boolean): Promise<{ text: string; links?: { uri: string; title: string }[]; trendingQueries?: string[] }> {
    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `I'm studying the concept of "${concept}" within the context of: "${truncatedContext}".
              
              Can you write a super engaging, "sticky" study guide for me? 
              
              GOAL: Make it so clear and interesting that I can remember the core ideas after just one reading.
              
              STYLE:
              - Use simple, punchy language (ELI5 style but for curious adults).
              - Use analogies and metaphors to make complex ideas "click".
              - Keep it warm and conversational.
              
              STRUCTURE:
              1. **The "Big Idea"**: A 1-sentence summary that sticks.
              2. **The "Why Should I Care?"**: Connect it to real life immediately.
              3. **The "Meat"**: Break down the core parts with clear headings.
              4. **"Did You Know?"**: Add 1-2 mind-blowing facts or recent studies.
              5. **Visuals**: Include 2-3 HIGHLY RELEVANT images that directly illustrate the specific sub-topic being discussed. Use this Markdown format: 
                 ![Description](https://loremflickr.com/800/450/[specific_topic_keyword])
                 (Replace [specific_topic_keyword] with a precise, single-word or hyphenated keyword that represents the visual content).
              
              IMPORTANT: 
              1. Write the main study guide in Markdown.
              2. Ensure images are placed naturally between sections where they add the most value.
              3. At the very end of your response, provide a list of 5-8 "Trending Queries" or "Real-time Topics" people are searching for related to this concept. 
              Format the list as a simple JSON array of strings, wrapped in [TRENDING_JSON] tags.
              Example: [TRENDING_JSON] ["How does X work?", "Recent news about Y", "X vs Z"] [/TRENDING_JSON]`
            }
          ]
        }
      ],
      config: {
        tools: useSearch ? [{ googleSearch: {} }] : []
      }
    });

    if (!response.text) {
      throw new Error("Empty response from AI model");
    }

    let mainText = response.text;
    let trendingQueries: string[] = [];

    // Try to extract trending queries using the new tag
    const trendingMatch = mainText.match(/\[TRENDING_JSON\]\s*(.*?)\s*\[\/TRENDING_JSON\]/s);
    if (trendingMatch) {
      try {
        trendingQueries = JSON.parse(trendingMatch[1]);
        mainText = mainText.replace(/\[TRENDING_JSON\].*?\[\/TRENDING_JSON\]/s, '').trim();
      } catch (e) {
        console.warn("Failed to parse trending queries JSON", e);
        // Fallback: try to extract anything that looks like an array
        const arrayMatch = trendingMatch[1].match(/\[\s*".*?"\s*\]/s);
        if (arrayMatch) {
          try { trendingQueries = JSON.parse(arrayMatch[0]); } catch(e2) {}
        }
      }
    } else {
      // Fallback for the old format just in case
      const oldMatch = mainText.match(/\[TRENDING_START\]\s*(.*?)\s*\[TRENDING_END\]/s);
      if (oldMatch) {
        try {
          trendingQueries = JSON.parse(oldMatch[1]);
          mainText = mainText.replace(/\[TRENDING_START\].*?\[TRENDING_END\]/s, '').trim();
        } catch (e) {
          console.warn("Failed to parse old trending queries format", e);
        }
      }
    }

    const links = response.candidates?.[0]?.groundingMetadata?.groundingChunks
      ?.map((chunk: any) => chunk.web ? { uri: chunk.web.uri, title: chunk.web.title } : null)
      .filter(Boolean) as { uri: string; title: string }[] | undefined;

    return {
      text: mainText,
      links,
      trendingQueries
    };
  }

  try {
    // Attempt 1: With Google Search
    return await attemptExpansion(true);
  } catch (error: any) {
    console.warn("Gemini Expansion with Search failed, trying fallback without search:", error);
    
    // Attempt 2: Fallback without Google Search (more reliable if search is failing)
    try {
      return await attemptExpansion(false);
    } catch (fallbackError: any) {
      console.error("Gemini Expansion Fallback Error:", fallbackError);
      throw fallbackError;
    }
  }
}

function getNodeColor(type: string): string {
  switch (type) {
    case 'root': return '#3b82f6'; // blue-500
    case 'main': return '#10b981'; // emerald-500
    case 'sub': return '#f59e0b';  // amber-500
    default: return '#94a3b8';    // slate-400
  }
}
