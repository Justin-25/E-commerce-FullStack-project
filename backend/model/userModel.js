const mongoose = require('mongoose');
const validator = require('validator');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'A user must have a name...']
    },
    email: {
      type: String,
      required: [true, 'A user must have a email...'],
      unique: true,
      lowercase: true,
      validate: [validator.isEmail, 'Please provide a valid email...']
    },
    password: {
      type: String,
      required: [true, 'A user must have a password'],
      minlength: 8,
      select: false
    },
    passwordConfirm: {
      type: String,
      required: [true, 'Please confirm your password...'],
      validate: {
        validator: function(el) {
          return el === this.password
        },
        message: 'Password do not match! Please try again...'
      }
    },
    photo: {
      type: String,
      default: 'default.jpg'
    },
    role: {
      type: String,
      enum: ['customer', 'staff', 'manager', 'owner', 'admin'],
      default: 'customer'
    },
    passwordChangeAt: String,
    passwordResetToken: String,
    passwordResetExpires: Date,
    active: {
      type: Boolean,
      default: true,
      select: false
    }
  }
);

//Mongoose middleware

// hashed password
userSchema.pre('save', async function() {
  if(!this.isModified('password')) {
    return;
  }

  this.password = await bcrypt.hash(this.password, 12);

  this.passwordConfirm = undefined;
});

// Intance method

// compare passwordCandidate on user password
userSchema.methods.correctPassword= async function(candidatePassword, userPassword) {
  return await bcrypt.compare(candidatePassword, userPassword);
};

const User = mongoose.model('User', userSchema);

module.exports = User