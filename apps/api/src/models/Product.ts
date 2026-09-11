import { Schema, model, Types } from "mongoose";

/** POS item or playtime package. Zone/branch-scoped. */
const productSchema = new Schema(
  {
    zoneId: { type: Types.ObjectId, ref: "Zone", required: true, index: true },
    branchId: { type: Types.ObjectId, ref: "Branch", index: true },
    name: { type: String, required: true },
    category: { type: String, default: "general" }, // snack / drink / accessory / package
    sku: String,
    price: { type: Schema.Types.Decimal128, required: true },
    cost: Schema.Types.Decimal128,
    stockQty: { type: Number, default: 0 },
    lowStockThreshold: { type: Number, default: 5 },
    isPackage: { type: Boolean, default: false },
    packageMinutes: Number, // for playtime packages
    image: String,
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Product = model("Product", productSchema);
