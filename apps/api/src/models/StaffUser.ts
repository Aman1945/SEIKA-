import { Schema, model, Types } from "mongoose";
import { SystemRole } from "./enums.js";

/**
 * Owner + staff accounts (operator side). Players are a separate collection.
 * `permissions` allows fine-grained RBAC on top of the base role.
 */
const staffUserSchema = new Schema(
  {
    zoneId: { type: Types.ObjectId, ref: "Zone", index: true }, // null for SUPER_ADMIN
    branchId: { type: Types.ObjectId, ref: "Branch" },
    role: { type: String, enum: SystemRole, required: true },
    customRoleName: String, // e.g. "Night Shift Cashier"
    permissions: { type: [String], default: [] }, // extra granular grants
    name: { type: String, required: true },
    phone: { type: String, unique: true, sparse: true },
    email: { type: String, unique: true, sparse: true },
    googleId: { type: String, unique: true, sparse: true },
    status: { type: String, default: "active" },
    twoFactorEnabled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const StaffUser = model("StaffUser", staffUserSchema);
