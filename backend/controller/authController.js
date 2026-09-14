const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../model/userModel');
const { redisClient } = require('../config/redis');

const ACCESS_COOKIE = process.env.ACCESS_TOKEN_SECRET;
const REFRESH_COOKIE = process.env.REFRESH_TOKEN_SECRET;

const accessCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 15 * 60 * 1000,
  path: '/' 
};

const refreshCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/api/users'
}

// JWT
const createAccessToken = userId => {
  return jwt.sign({ sub: userId }, process.env.ACCESS_TOKEN_SECRET, {
    expiresIn: '15m'
  });
}

const createRefreshToken = (userId, tokenId) => {
  return jwt.sign({ sub: userId, jti: tokenId }, process.env.REFRESH_TOKEN_SECRET, {
    expiresIn: '7d'
  });
}

const createRefreshSession = async (userId) => {
  const tokenId = crypto.randomUUID();
  const sessionKey = `refresh:${tokenId}`;
  const userSessionKey = `user-session:${userId}`;

  await redisClient.set(
    sessionKey,
    userId,
    {
      EX: 7 * 24 * 60 * 60
    }
  );

  await redisClient.sAdd(userSessionKey, tokenId);

  return tokenId;
}

exports.signup = async (req, res) => {
  try {
    const { name, email, password, passwordConfirm } = req.body;

    const user = await User.create({
      name,
      email,
      password,
      passwordConfirm
    });

    user.password = undefined;
    user.active = undefined;

    res.status(201).json({
      status: 'success',
      data: {
        id: user._id,
        name: user.name,
        email: user.email
      }
    });
  } catch (error) {
    res.status(400).json({
      status: 'fail',
      message: error.message
    })
  }
}