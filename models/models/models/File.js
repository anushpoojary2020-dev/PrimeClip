const mongoose = require("mongoose");

const fileSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true },
    caption: { type: String },
    url: { type: String, required: true },
    price: { type: Number, required: true },
    premium: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("File", fileSchema);
