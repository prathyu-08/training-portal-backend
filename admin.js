const AWS = require("aws-sdk");
const dynamo = new AWS.DynamoDB.DocumentClient();
const { verifyToken } = require("./auth");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
const { generateSummary } = require("./aiSummarizer");

const TABLE_NAME = process.env.DYNAMODB_TABLE;

// ADMIN CHECK 
const requireAdmin = async (event) => {
  const token =
    event.headers.authorization?.split(" ")[1] ||
    event.headers.Authorization?.split(" ")[1];

  if (!token) throw new Error("No token");

  const user = await verifyToken(token);

  if (!user.email.toLowerCase().endsWith("@nmkglobalinc.com")) {
    throw new Error("Admin access required");
  }

  return user;
};

// COURSES

// POST /admin/courses
exports.createCourse = async (event, body) => {
  try {
    const admin = await requireAdmin(event);

    const course_id = uuidv4();

    const course = {
      PK: `COURSE#${course_id}`,
      SK: "METADATA",
      type: "course",
      course_id,
      title: body.title,
      description: body.description,
      created_by: admin.sub,
      status: "draft",
      created_at: new Date().toISOString(),
    };

    console.log("Writing to table:", TABLE_NAME);
    console.log("Course object:", JSON.stringify(course));

    await dynamo.put({
      TableName: TABLE_NAME,
      Item: course,
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
    }).promise();

    console.log("✅ SUCCESSFULLY WRITTEN");

    return { message: "Course created", course_id };

  } catch (err) {
    console.error("❌ ERROR:", err);
    throw err;
  }
};

// PUT /admin/courses/{id}
exports.updateCourse = async (event, body, course_id) => {
  await requireAdmin(event);

  await dynamo.update({
    TableName: TABLE_NAME,
    Key: {
      PK: `COURSE#${course_id}`,
      SK: "METADATA",
    },
    UpdateExpression:
      "SET title = :t, description = :d, #s = :status",
    ExpressionAttributeNames: {
      "#s": "status",
    },
    ExpressionAttributeValues: {
      ":t": body.title,
      ":d": body.description,
      ":status": body.status || "draft",
    },
  }).promise();

  return { message: "Course updated" };
};

// VIDEO 
// POST /admin/videos
exports.addVideo = async (event, body) => {
  console.log("🔥 ADD VIDEO API HIT");
  await requireAdmin(event);

  const video_id = uuidv4();

  const yt = await axios.get(
    `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${body.youtube_video_id}&format=json`
  );

  await dynamo.put({
    TableName: TABLE_NAME,
    Item: {
      PK: `COURSE#${body.course_id}`,
      SK: `VIDEO#${video_id}`,
      type: "course_video",
      video_id,
      created_at: new Date().toISOString(),
    },
  }).promise();

  await dynamo.put({
    TableName: TABLE_NAME,
    Item: {
      PK: `VIDEO#${video_id}`,
      SK: "METADATA",
      type: "video",
      video_id,
      course_id: body.course_id,
      youtube_video_id: body.youtube_video_id,
      title: body.custom_title || yt.data.title,
      thumbnail_url: yt.data.thumbnail_url,
      created_at: new Date().toISOString(),
    },
  }).promise();

  console.log("🔥 STEP 1 — video metadata saved");

  // Fire-and-forget summary generation (don't block the response)
  try {
    console.log("🔥 STEP 2 — calling summary async");
    generateSummary(video_id, body.youtube_video_id)
      .then(() => console.log("🔥 STEP 3 — summary finished async"))
      .catch(e => console.log("🔥 SUMMARY ASYNC FAILED:", e));
  } catch (e) {
    console.log("🔥 SUMMARY FAILED:", e);
  }

  return { message: "Video added", video_id };
};

//GET VIDEO SUMMARY ON-DEMAND 
// POST /admin/videos/{videoId}/summary
exports.getVideoSummary = async (event, videoId) => {
  await requireAdmin(event);

  // Fetch existing video metadata
  const video = await dynamo.get({
    TableName: TABLE_NAME,
    Key: {
      PK: `VIDEO#${videoId}`,
      SK: "METADATA",
    },
  }).promise();

  if (!video.Item) {
    throw new Error("Video not found");
  }

  // If summary already exists, return it
  if (video.Item.ai_summary && video.Item.ai_summary.length > 20) {
    return { summary: video.Item.ai_summary, from_cache: true };
  }

  // Otherwise generate fresh summary
  console.log("🔥 ON-DEMAND SUMMARY for:", videoId);
  const summary = await generateSummary(videoId, video.Item.youtube_video_id);

  if (!summary) {
    throw new Error("Failed to generate summary. Please try again.");
  }

  return { summary, from_cache: false };
};

// ACCESS 

exports.grantAccess = async (event, body) => {
  const admin = await requireAdmin(event);

  console.log("BODY:", body);

  const userResult = await dynamo.scan({
    TableName: TABLE_NAME,
    FilterExpression: "email = :email AND SK = :sk",
    ExpressionAttributeValues: {
      ":email": body.email,
      ":sk": "PROFILE",
    },
  }).promise();

  console.log("USER FOUND:", userResult.Items);

  if (!userResult.Items.length) {
    throw new Error("User not found");
  }

  const user = userResult.Items[0];

  const access = {
    PK: `USER#${user.user_id}`,
    SK: `ACCESS#COURSE#${body.course_id}`,
    type: "access",
    course_id: body.course_id,
    granted_by: admin.sub,
    granted_at: new Date().toISOString(),
  };

  console.log("WRITING ACCESS:", access);

  await dynamo.put({
    TableName: TABLE_NAME,
    Item: access,
  }).promise();

  console.log("✅ ACCESS CREATED");

  return { message: "Access granted" };
};

// DELETE /admin/access
exports.revokeAccess = async (event) => {
  await requireAdmin(event);

  //  read from queryStringParameters (DELETE requests don't have body)
  const email = event.queryStringParameters?.email;
  const course_id = event.queryStringParameters?.course_id;

  console.log("REVOKE EMAIL:", email);
  console.log("REVOKE COURSE:", course_id);

  if (!email || !course_id) {
    throw new Error("Missing email or course_id");
  }

  const userResult = await dynamo.scan({
    TableName: TABLE_NAME,
    FilterExpression: "email = :email AND SK = :sk",
    ExpressionAttributeValues: {
      ":email": email,
      ":sk": "PROFILE",
    },
  }).promise();

  console.log("USER FOUND:", userResult.Items);

  if (!userResult.Items.length) {
    throw new Error("User not found");
  }

  const user = userResult.Items[0];

  await dynamo.delete({
    TableName: TABLE_NAME,
    Key: {
      PK: `USER#${user.user_id}`,
      SK: `ACCESS#COURSE#${course_id}`,
    },
  }).promise();

  console.log("✅ ACCESS DELETED");

  return { message: "Access revoked" };
};

//USERS 

// GET /admin/users
exports.listUsers = async (event) => {
  await requireAdmin(event);

  const users = await dynamo.scan({
    TableName: TABLE_NAME,
    FilterExpression: "begins_with(PK, :pk) AND SK = :sk",
    ExpressionAttributeValues: {
      ":pk": "USER#",
      ":sk": "PROFILE",
    },
  }).promise();

  const result = [];

  for (const user of users.Items) {
    const access = await dynamo.query({
      TableName: TABLE_NAME,
      KeyConditionExpression:
        "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: {
        ":pk": user.PK,
        ":sk": "ACCESS#COURSE#",
      },
    }).promise();

    result.push({
      user_id: user.user_id,
      email: user.email,
      name: user.name,
      assigned_courses: access.Items.map(a => a.course_id),
    });
  }

  return result;
};

//LIST COURSES 

exports.listCourses = async (event) => {
  await requireAdmin(event);

  const data = await dynamo.scan({
    TableName: TABLE_NAME,
    FilterExpression: "#type = :type AND SK = :sk",
    ExpressionAttributeNames: {
      "#type": "type"
    },
    ExpressionAttributeValues: {
      ":type": "course",
      ":sk": "METADATA"
    }
  }).promise();

  return data.Items;
};

// GET /admin/courses
exports.getAdminCourses = async (event) => {
  await requireAdmin(event);

  const result = await dynamo.scan({
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

  return result.Items;
};

// DELETE /admin/courses/{id}
exports.deleteCourse = async (event, course_id) => {
  await requireAdmin(event);

  await dynamo.delete({
    TableName: TABLE_NAME,
    Key: {
      PK: `COURSE#${course_id}`,
      SK: "METADATA",
    },
  }).promise();

  return { message: "Course deleted successfully" };
};

// GET /admin/courses/{id}
exports.getCourseById = async (event, course_id) => {
  await requireAdmin(event);

  const result = await dynamo.get({
    TableName: TABLE_NAME,
    Key: {
      PK: `COURSE#${course_id}`,
      SK: "METADATA",
    },
  }).promise();

  if (!result.Item) {
    throw new Error("Course not found");
  }

  return result.Item;
};

// GET /admin/courses/{id}/videos
exports.listCourseVideos = async (event, courseId) => {
  await requireAdmin(event);

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
    const videoId = rel.SK.replace("VIDEO#", "");

    const videoMeta = await dynamo.get({
      TableName: TABLE_NAME,
      Key: {
        PK: `VIDEO#${videoId}`,
        SK: "METADATA",
      },
    }).promise();

    if (videoMeta.Item) {
      videos.push({
        video_id: videoMeta.Item.video_id,
        title: videoMeta.Item.title,
        thumbnail_url: videoMeta.Item.thumbnail_url,
        ai_summary: videoMeta.Item.ai_summary || null,
      });
    }
  }

  return { videos };
};

// GET /admin/courses/{courseId}/users
exports.getUsersByCourse = async (event, course_id) => {
  await requireAdmin(event);

  const users = await dynamo.scan({
    TableName: TABLE_NAME,
    FilterExpression: "begins_with(PK, :pk) AND SK = :sk",
    ExpressionAttributeValues: {
      ":pk": "USER#",
      ":sk": "PROFILE",
    },
  }).promise();

  const result = [];

  for (const user of users.Items) {
    const access = await dynamo.query({
      TableName: TABLE_NAME,
      KeyConditionExpression:
        "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: {
        ":pk": user.PK,
        ":sk": "ACCESS#COURSE#",
      },
    }).promise();

    const hasCourse = access.Items.find(
      (a) => a.course_id === course_id
    );

    if (hasCourse) {
      result.push({
        user_id: user.user_id,
        email: user.email,
      });
    }
  }

  return { users: result };
};

// DELETE /admin/videos/{videoId}
exports.deleteVideo = async (event, videoId) => {
  await requireAdmin(event);

  const video = await dynamo.get({
    TableName: TABLE_NAME,
    Key: {
      PK: `VIDEO#${videoId}`,
      SK: "METADATA",
    },
  }).promise();

  if (!video.Item) {
    throw new Error("Video not found");
  }

  const courseId = video.Item.course_id;

  await dynamo.delete({
    TableName: TABLE_NAME,
    Key: {
      PK: `VIDEO#${videoId}`,
      SK: "METADATA",
    },
  }).promise();

  await dynamo.delete({
    TableName: TABLE_NAME,
    Key: {
      PK: `COURSE#${courseId}`,
      SK: `VIDEO#${videoId}`,
    },
  }).promise();

  return { message: "Video deleted successfully" };
};

// PUT /admin/videos/{videoId}
exports.updateVideo = async (event, body, videoId) => {
  await requireAdmin(event);

  if (!body.custom_title) {
    throw new Error("Title is required");
  }

  await dynamo.update({
    TableName: TABLE_NAME,
    Key: {
      PK: `VIDEO#${videoId}`,
      SK: "METADATA",
    },
    UpdateExpression: "SET title = :t",
    ExpressionAttributeValues: {
      ":t": body.custom_title,
    },
  }).promise();

  return { message: "Video updated successfully" };
};
