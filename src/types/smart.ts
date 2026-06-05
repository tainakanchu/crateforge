export type SmartOp =
  | "is"
  | "isNot"
  | "contains"
  | "notContains"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "exists"
  | "notExists";

export interface SmartRule {
  field: string;
  op: SmartOp;
  value: string;
}

export interface SmartCriteria {
  matchAll: boolean;
  rules: SmartRule[];
  limit: number | null;
  sortBy: string | null;
  sortDesc: boolean;
}
