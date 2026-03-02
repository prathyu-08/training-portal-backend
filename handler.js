require("dotenv").config();

const AWS = require("aws-sdk");
const dynamo = new AWS.DynamoDB.DocumentClient();
const jwt = require("jsonwebtoken");
const TABLE_NAME = process.env.DYNAMODB_TABLE;
console.log("TABLE NAME:", TABLE_NAME);
const { register, verifyUser, login } = require("./cognito");
const { verifyToken } = require("./auth");
const admin = require("./admin");

exports.handler = async (event) => {
  try {
    const path = event.rawPath;
    const method = event.requestContext.http.method;
    const body = event.body ? JSON.parse(event.body) : {};
    
    if (method === "OPTIONS") {
      return response(200, {});
    }

    const getToken = () =>
      event.headers.authorization?.split(" ")[1] ||
      event.headers.Authorization?.split(" ")[1];

    /* ================= AUTH ================= */

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

      const role = email.toLowerCase().endsWith("@nmkglobalinc.com")
        ? "admin"
        : "user";

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

    /* ================= PROTECTED ================= */

    if (path === "/secure" && method === "GET") {
      const token = getToken();
      if (!token) throw new Error("No token");

      const user = await verifyToken(token);

      return response(200, {
        message: "Authorized",
        user_id: user.sub,
        email: user.email,
      });
    }

    /* ================= ADMIN ROUTES ================= */

// 1️⃣ Collection
if (path === "/admin/courses" && method === "GET") {
  return response(200, await admin.getAdminCourses(event));
}

// 2️⃣ Create
if (path === "/admin/courses" && method === "POST") {
  return response(200, await admin.createCourse(event, body));
}

// 3️⃣ Single course GET
if (
  path.match(/^\/admin\/courses\/[^/]+$/) &&
  method === "GET"
) {
  const id = path.split("/")[3];
  return response(200, await admin.getCourseById(event, id));
}

// 4️⃣ Update
if (
  path.match(/^\/admin\/courses\/[^/]+$/) &&
  method === "PUT"
) {
  const id = path.split("/")[3];
  return response(200, await admin.updateCourse(event, body, id));
}

// 5️⃣ Delete
if (
  path.match(/^\/admin\/courses\/[^/]+$/) &&
  method === "DELETE"
) {
  const id = path.split("/")[3];
  return response(200, await admin.deleteCourse(event, id));
}

if (path.match(/^\/admin\/courses\/[^/]+\/videos$/) && method === "GET") {
  const courseId = path.split("/")[3];
  return response(
    200,
    await admin.listCourseVideos(event, courseId)
  );
}

if (path.match(/^\/admin\/courses\/[^/]+\/users$/) && method === "GET") {
  const courseId = path.split("/")[3];
  return response(
    200,
    await admin.getUsersByCourse(event, courseId)
  );
}
if (path.includes("/admin/videos") && method === "POST") {
  return response(200, await admin.addVideo(event, body));
}

if (
  path.match(/^\/admin\/videos\/[^/]+$/) &&
  method === "PUT"
) {
  const videoId = path.split("/")[3];
  return response(200, await admin.updateVideo(event, body, videoId));
}

if (
  path.match(/^\/admin\/videos\/[^/]+$/) &&
  method === "DELETE"
) {
  const videoId = path.split("/")[3];
  return response(200, await admin.deleteVideo(event, videoId));
}

if (path.includes("/admin/access") && method === "POST") {
  return response(200, await admin.grantAccess(event, body));
}

if (path.includes("/admin/access") && method === "DELETE") {
  return response(200, await admin.revokeAccess(event, body));
}

if (path.includes("/admin/users") && method === "GET") {
  return response(200, await admin.listUsers(event));
}

if (path.includes("/admin/groups") && method === "POST") {
  return response(200, await admin.createGroup(event, body));
}

if (path.includes("/admin/groups") && method === "GET") {
  return response(200, await admin.listGroups(event));
}

if (path.includes("/admin/group/assign-user") && method === "POST") {
  return response(200, await admin.assignUserToGroup(event, body));
}

if (path.includes("/admin/group/assign-course") && method === "POST") {
  return response(200, await admin.assignCourseToGroup(event, body));
}


    /* ================= USER ENDPOINTS ================= */
// ✅ NEW API: GET ALL VIDEOS FOR USER
if (path.match(/^\/courses\/[^/]+\/videos$/) && method === "GET") {
  const token = getToken();
  const user = await verifyToken(token);

  const courseId = path.split("/")[2];
  const userPK = `USER#${user.sub}`;

  // 🔐 Check access
  const access = await dynamo.get({
    TableName: TABLE_NAME,
    Key: {
      PK: userPK,
      SK: `ACCESS#COURSE#${courseId}`,
    },
  }).promise();

  if (!access.Item) {
    return response(403, { message: "Access denied" });
  }

  // 📺 Get videos
  const relations = await dynamo.query({
    TableName: TABLE_NAME,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": `COURSE#${courseId}`,
      ":sk": "VIDEO#",
    },
  }).promise();

  const videos = [];

  for (const rel of relations.Items) {
    const video_id = rel.SK.replace("VIDEO#", "");

    const video = await dynamo.get({
      TableName: TABLE_NAME,
      Key: {
        PK: `VIDEO#${video_id}`,
        SK: "METADATA",
      },
    }).promise();

    if (video.Item) {
      videos.push({
        video_id: video.Item.video_id,
        title: video.Item.title,
        thumbnail_url: video.Item.thumbnail_url,
      });
    }
  }

  return response(200, { videos });
}

// GET /video/{video_id}/embed
if (path.match(/^\/video\/[^/]+\/embed$/) && method === "GET") {
  const video_id = path.split("/")[2];

  const token = getToken();
  const user = await verifyToken(token);

  // 🔐 Check access
  const access = await dynamo.query({
    TableName: TABLE_NAME,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": `USER#${user.sub}`,
      ":sk": "ACCESS#COURSE#",
    },
  }).promise();

  if (!access.Items.length) {
    return response(403, { message: "Access denied" });
  }

  // 👉 Get video metadata
  const video = await dynamo.get({
    TableName: TABLE_NAME,
    Key: {
      PK: `VIDEO#${video_id}`,
      SK: "METADATA",
    },
  }).promise();

  if (!video.Item) {
    return response(404, { message: "Video not found" });
  }

  // 🔥 IMPORTANT: Build embed URL here (NOT frontend)
  const embedUrl =
  `https://www.youtube-nocookie.com/embed/${video.Item.youtube_video_id}` +
  `?rel=0&modestbranding=1&playsinline=1`;

  return response(200, {
    title: video.Item.title,
    embed_url: embedUrl,
  });
}
// GET /courses → user assigned courses
if (path === "/courses" && method === "GET") {
  const token = getToken();
  const user = await verifyToken(token);
  
  const userPK = `USER#${user.sub}`;

  // 🔥 If admin → return ALL courses
  if (user.email.toLowerCase().endsWith("@nmkglobalinc.com")) {

    const allCourses = await dynamo.scan({
      TableName: TABLE_NAME,
      FilterExpression: "#type = :type AND SK = :sk",
      ExpressionAttributeNames: {
        "#type": "type",
      },
      ExpressionAttributeValues: {
        ":type": "course",
        ":sk": "METADATA",
      },
    }).promise();

    return response(200, allCourses.Items);
  }

  // 🔥 Normal user → assigned courses only

  // 1️⃣ Direct access
  const directAccess = await dynamo.query({
    TableName: TABLE_NAME,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :course)",
    ExpressionAttributeValues: {
      ":pk": userPK,
      ":course": "ACCESS#COURSE#",
    },
    ConsistentRead: true   // ✅ VERY IMPORTANT
  }).promise();
  // 2️⃣ Group memberships


  const directCourseIds = directAccess.Items.map(
    (i) => i.course_id
  );
  const allCourseIds = [...new Set(directCourseIds)];
  const courseDetails = [];

for (const courseId of allCourseIds) {
  const course = await dynamo.get({
    TableName: TABLE_NAME,
    Key: {
      PK: `COURSE#${courseId}`,
      SK: "METADATA",
    },
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

    return response(404, { message: "Not found" });

  } catch (err) {
    console.error("ERROR:", err);
    return response(500, { error: err.message });
  }
};

/* ================= RESPONSE ================= */

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    "Access-Control-Allow-Origin": "http://localhost:5173",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,POST,GET,PUT,DELETE",
  },
  body: JSON.stringify(body),
});

/* ================= USER MODEL ================= */

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
