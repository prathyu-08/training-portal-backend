const jwt = require("jsonwebtoken");
const jwkToPem = require("jwk-to-pem");
const axios = require("axios");

const REGION = process.env.AWS_REGION;
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;

const JWKS_URL = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}/.well-known/jwks.json`;

let pems = null;

//LOAD & CACHE JWKS 

const getPems = async () => {
  if (pems) return pems;

  const { data } = await axios.get(JWKS_URL);
  pems = {};

  data.keys.forEach((key) => {
    pems[key.kid] = jwkToPem(key);
  });

  return pems;
};

// VERIFY COGNITO TOKEN 

const verifyToken = async (token) => {
  try {
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded) {
      throw new Error("Invalid JWT token");
    }

    const pems = await getPems();
    const pem = pems[decoded.header.kid];
    if (!pem) {
      throw new Error("Invalid token signing key");
    }

    const verified = jwt.verify(token, pem, {
      issuer: `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`,
      algorithms: ["RS256"],
    });

    // ✅ NOW EXPECT ID TOKEN
    if (verified.token_use !== "id") {
      throw new Error("Invalid token type (expected id token)");
    }

    return verified;

  } catch (err) {
    console.error("❌ TOKEN VERIFY ERROR:", err.message);
    throw new Error("Unauthorized");
  }
};
module.exports = { verifyToken };
