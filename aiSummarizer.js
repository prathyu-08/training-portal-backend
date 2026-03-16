const AWS = require("aws-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const dynamo = new AWS.DynamoDB.DocumentClient();
const TABLE_NAME = process.env.DYNAMODB_TABLE;

async function generateSummary(video_id, youtube_video_id) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY env variable is not set");
  }

  if (!youtube_video_id) {
    throw new Error("youtube_video_id is required");
  }

  const youtubeUrl = `https://www.youtube.com/watch?v=${youtube_video_id}`;
  console.log("Generating summary for:", youtubeUrl);

  const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = ai.getGenerativeModel({ model: "gemini-2.5-flash" });

  const result = await model.generateContent([
    {
      fileData: {
        fileUri: youtubeUrl,
      },
    },
    {
      text: "Give a quick overview of this video in 5 to 6 short lines only. Cover: what it's about, the main point, and one or two key takeaways. Be concise; no long paragraphs.",
    },
  ]);

  const summary = result.response.text();

  if (!summary || summary.trim() === "") {
    throw new Error("No summary generated. The video may be private or unavailable.");
  }

  console.log("✅ Summary generated:", summary.substring(0, 100) + "...");

  await dynamo.update({
    TableName: TABLE_NAME,
    Key: { PK: `VIDEO#${video_id}`, SK: "METADATA" },
    UpdateExpression: "SET ai_summary = :s",
    ExpressionAttributeValues: { ":s": summary.trim() }
  }).promise();

  console.log("✅ Summary saved to DB");
  return summary.trim();
}

module.exports = { generateSummary };
