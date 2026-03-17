require("dotenv").config();

const AWS = require("aws-sdk");
const dynamo = new AWS.DynamoDB.DocumentClient();
const jwt = require("jsonwebtoken");
const TABLE_NAME = process.env.DYNAMODB_TABLE;
console.log("TABLE NAME:", TABLE_NAME);
const { register, verifyUser, login } = require("./cognito");
const { verifyToken } = require("./auth");
const admin = require("./admin");
const { generateSummary } = require("./aiSummarizer");

exports.handler = async (event) => {
  console.log("EVENT rawPath:", event.rawPath);
  console.log("EVENT path:", event.path);
  console.log("EVENT METHOD:", event.requestContext?.http?.method || event.httpMethod);
  console.log("EVENT routeKey:", event.routeKey);

  try {  
    const path = (event.rawPath || event.path || "").replace(/\/$/, ""); // strip trailing slash
    const method = event.requestContext?.http?.method || event.httpMethod;
    const body = event.body ? JSON.parse(event.body) : {};

    console.log("RESOLVED path:", JSON.stringify(path));
    console.log("RESOLVED method:", method);

    if (method === "OPTIONS") {
      return response(200, {});
    }

    if (path === "/debug" || path.endsWith("/debug")) {
      return response(200, {
        rawPath: event.rawPath,
        path: event.path,
        resolvedPath: path,
        method,
        routeKey: event.routeKey,
      });
    }

    const getToken = () =>
      event.headers?.authorization?.split(" ")[1] ||
      event.headers?.Authorization?.split(" ")[1];

    if (path === "/register" && method === "POST") {
      await register(body.email, body.password);
      return response(200, { message: "User registered. Check email for OTP." });
    }

    if (path === "/verify" && method === "POST") {
      await verifyUser(body.email, body.otp);
      return response(200, { message: "User verified successfully" });
    }

    if (path === "/login" && method === "POST") {
      const data = await login(body.email, body.password);
      const decoded = jwt.decode(data.id_token);
      const user_id = decoded.sub;
      const email = decoded.email;
      const role = email.toLowerCase().endsWith("@nmkglobalinc.com") ? "admin" : "user";

      try {
        await dynamo.put({
          TableName: TABLE_NAME,
          Item: createUserItem(user_id, email, role),
          ConditionExpression: "attribute_not_exists(PK)",
        }).promise();
      } catch (err) {
        if (err.code !== "ConditionalCheckFailedException") throw err;
      }

      return response(200, data);
    }

    if (path === "/secure" && method === "GET") {
      const token = getToken();
      if (!token) throw new Error("No token");
      const user = await verifyToken(token);
      return response(200, { message: "Authorized", user_id: user.sub, email: user.email });
    }

    if (path === "/admin/courses" && method === "GET") {
      return response(200, await admin.getAdminCourses(event));
    }

    if (path === "/admin/courses" && method === "POST") {
      return response(200, await admin.createCourse(event, body));
    }
    
    if (method === "GET" && path.includes("/admin/videos/") && path.endsWith("/summary")) {
      // Extract videoId safely: strip /admin/videos/ prefix and /summary suffix
      const videoId = path.replace(/.*\/admin\/videos\//, "").replace("/summary", "");
      console.log("✅ SUMMARY ROUTE HIT — videoId:", videoId);
      return response(200, await admin.getVideoSummary(event, videoId));
    }

    if (path.match(/^\/admin\/courses\/[^/]+$/) && method === "GET") {
      const id = path.split("/")[3];
      return response(200, await admin.getCourseById(event, id));
    }

    if (path.match(/^\/admin\/courses\/[^/]+$/) && method === "PUT") {
      const id = path.split("/")[3];
      return response(200, await admin.updateCourse(event, body, id));
    }

    if (path.match(/^\/admin\/courses\/[^/]+$/) && method === "DELETE") {
      const id = path.split("/")[3];
      return response(200, await admin.deleteCourse(event, id));
    }

    if (path.match(/^\/admin\/courses\/[^/]+\/videos$/) && method === "GET") {
      const courseId = path.split("/")[3];
      return response(200, await admin.listCourseVideos(event, courseId));
    }

    if (path.match(/^\/admin\/courses\/[^/]+\/users$/) && method === "GET") {
      const courseId = path.split("/")[3];
      return response(200, await admin.getUsersByCourse(event, courseId));
    }

    // POST /admin/videos — add new video
    if (path === "/admin/videos" && method === "POST") {
      return response(200, await admin.addVideo(event, body));
    }
    // Also handle if path has no trailing specifics (startsWith safety)
    if (path.startsWith("/admin/videos") && method === "POST" && !path.includes("/summary")) {
      return response(200, await admin.addVideo(event, body));
    }

    if (path.match(/^\/admin\/videos\/[^/]+$/) && method === "PUT") {
      const videoId = path.split("/")[3];
      return response(200, await admin.updateVideo(event, body, videoId));
    }

    if (path.match(/^\/admin\/videos\/[^/]+$/) && method === "DELETE") {
      const videoId = path.split("/")[3];
      return response(200, await admin.deleteVideo(event, videoId));
    }

    if (path.includes("/admin/access") && method === "POST") {
      return response(200, await admin.grantAccess(event, body));
    }

    if (path.includes("/admin/access") && method === "DELETE") {
      return response(200, await admin.revokeAccess(event));
    }

    if (path.includes("/admin/users") && method === "GET") {
      return response(200, await admin.listUsers(event));
    }

    if (path.match(/^\/admin\/regen-summary\/[^/]+$/) && method === "POST") {
      const video_id = path.split("/")[3];
      const video = await dynamo.get({
        TableName: TABLE_NAME,
        Key: { PK: `VIDEO#${video_id}`, SK: "METADATA" }
      }).promise();
      if (!video.Item) return response(404, { message: "Video not found" });
      await generateSummary(video_id, video.Item.youtube_video_id);
      return response(200, { message: "Summary regenerated" });
    }

    if (path.match(/^\/courses\/[^/]+\/videos$/) && method === "GET") {
      const token = getToken();
      const user = await verifyToken(token);
      const courseId = path.split("/")[2];
      const userPK = `USER#${user.sub}`;

      const access = await dynamo.get({
        TableName: TABLE_NAME,
        Key: { PK: userPK, SK: `ACCESS#COURSE#${courseId}` },
        ConsistentRead: true
      }).promise();

      if (!access.Item) return response(403, { message: "Access denied" });

      const relations = await dynamo.query({
        TableName: TABLE_NAME,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": `COURSE#${courseId}`, ":sk": "VIDEO#" },
        ConsistentRead: true
      }).promise();

      relations.Items.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

      const videos = [];
      for (const rel of relations.Items) {
        const video_id = rel.SK.replace("VIDEO#", "");
        const video = await dynamo.get({
          TableName: TABLE_NAME,
          Key: { PK: `VIDEO#${video_id}`, SK: "METADATA" },
          ConsistentRead: true
        }).promise();
        if (video.Item) {
          videos.push({
            video_id: video.Item.video_id,
            title: video.Item.title,
            thumbnail_url: video.Item.thumbnail_url,
            ai_summary: video.Item.ai_summary || null,
          });
        }
      }
      return response(200, { videos });
    }

    if (path.match(/^\/video\/[^/]+\/embed$/) && method === "GET") {
      const video_id = path.split("/")[2];
      const token = getToken();
      await verifyToken(token);
      const video = await dynamo.get({
        TableName: TABLE_NAME,
        Key: { PK: `VIDEO#${video_id}`, SK: "METADATA" }
      }).promise();
      if (!video.Item) return response(404, { message: "Video not found" });
      return response(200, {
        title: video.Item.title,
        embed_url: `https://www.youtube-nocookie.com/embed/${video.Item.youtube_video_id}`,
        ai_summary: video.Item.ai_summary || null,
      });
    }

    if (path.match(/^\/video\/[^/]+\/progress$/) && method === "GET") {
      const video_id = path.split("/")[2];
      const token = getToken();
      const user = await verifyToken(token);
      const item = await dynamo.get({
        TableName: TABLE_NAME,
        Key: { PK: `USER#${user.sub}`, SK: `VIDEO_PROGRESS#${video_id}` }
      }).promise();
      return response(200, { progress_seconds: item.Item?.progress_seconds || 0 });
    }

    if (path.match(/^\/video\/[^/]+\/progress$/) && method === "PUT") {
      const video_id = path.split("/")[2];
      const token = getToken();
      const user = await verifyToken(token);
      await dynamo.put({
        TableName: TABLE_NAME,
        Item: {
          PK: `USER#${user.sub}`,
          SK: `VIDEO_PROGRESS#${video_id}`,
          progress_seconds: body.progress_seconds || 0,
          updated_at: new Date().toISOString()
        }
      }).promise();
      return response(200, { message: "Progress saved" });
    }

    if (path === "/courses" && method === "GET") {
      const token = getToken();
      const user = await verifyToken(token);
      const userPK = `USER#${user.sub}`;

      if (user.email.toLowerCase().endsWith("@nmkglobalinc.com")) {
        const allCourses = await dynamo.scan({
          TableName: TABLE_NAME,
          FilterExpression: "#type = :type AND SK = :sk",
          ExpressionAttributeNames: { "#type": "type" },
          ExpressionAttributeValues: { ":type": "course", ":sk": "METADATA" },
        }).promise();
        return response(200, allCourses.Items);
      }

      const directAccess = await dynamo.query({
        TableName: TABLE_NAME,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :course)",
        ExpressionAttributeValues: { ":pk": userPK, ":course": "ACCESS#COURSE#" },
        ConsistentRead: true
      }).promise();

      const allCourseIds = [...new Set(directAccess.Items.map(i => i.course_id))];
      const courseDetails = [];

      for (const courseId of allCourseIds) {
        const course = await dynamo.get({
          TableName: TABLE_NAME,
          Key: { PK: `COURSE#${courseId}`, SK: "METADATA" },
          ConsistentRead: true
        }).promise();
        if (course.Item) {
          courseDetails.push({
            course_id: course.Item.course_id,
            title: course.Item.title,
            description: course.Item.description,
          });
        }
      }
      return response(200, courseDetails);
    }

    console.log("❌ NO ROUTE MATCHED — path:", JSON.stringify(path), "method:", method);
    return response(404, { message: "Not found", debug_path: path, debug_method: method });

  } catch (err) {
    console.error("ERROR:", err.message, err.stack);
    return response(500, { error: err.message });
  }
};


const response = (statusCode, body) => ({
  statusCode,
  headers: {
    "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,POST,GET,PUT,DELETE",
  },
  body: JSON.stringify(body),
});

const createUserItem = (user_id, email, role) => ({
  PK: `USER#${user_id}`,
  SK: "PROFILE",
  user_id,
  name: "New User",
  email,
  role,
  status: "active",
  created_at: new Date().toISOString(),
  GSI1PK: `EMAIL#${email}`,
  GSI1SK: `USER#${user_id}`,
});
