const AWS = require("aws-sdk");

const cognito = new AWS.CognitoIdentityServiceProvider({
  region: process.env.AWS_REGION,
});

const CLIENT_ID = process.env.COGNITO_CLIENT_ID;

//  REGISTER
const register = async (email, password) => {
  return await cognito
    .signUp({
      ClientId: CLIENT_ID,
      Username: email,
      Password: password,
      UserAttributes: [
        {
          Name: "email",
          Value: email,
        },
      ],
    })
    .promise();
};

//  VERIFY
const verifyUser = async (email, otp) => {
  return await cognito
    .confirmSignUp({
      ClientId: CLIENT_ID,
      Username: email,
      ConfirmationCode: otp,
    })
    .promise();
};

//  LOGIN
const login = async (email, password) => {
  const response = await cognito
    .initiateAuth({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: CLIENT_ID,
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
      },
    })
    .promise();

  return {
    access_token: response.AuthenticationResult.AccessToken,
    id_token: response.AuthenticationResult.IdToken,      // 👈 ADD THIS
    refresh_token: response.AuthenticationResult.RefreshToken,
  };
};
const refresh = async (refreshToken) => {
  const response = await cognito
    .initiateAuth({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: CLIENT_ID,
      AuthParameters: {
        REFRESH_TOKEN: refreshToken,
      },
    })
    .promise();

  return {
    access_token: response.AuthenticationResult.AccessToken,
    id_token: response.AuthenticationResult.IdToken,
  };
};

// LOGOUT 
const logout = async (accessToken) => {
  return await cognito
    .globalSignOut({
      AccessToken: accessToken,
    })
    .promise();
};

module.exports = { register, verifyUser, login, refresh, logout };



