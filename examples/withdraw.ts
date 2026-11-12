import { contract } from "../src/contract.js";

export function withdraw(balance: bigint, amount: bigint): bigint {
  return balance - amount;
}

contract(withdraw, {
  requires: (balance, amount) => balance >= 0n && amount > 0n && amount <= balance,
  ensures: (result, balance, amount) => result >= 0n && result === balance - amount,
});

export function payChecked(balance: bigint, amount: bigint): bigint {
  if (balance < 0n || amount <= 0n || amount > balance) return 0n;
  return withdraw(balance, amount);
}

export function payUnchecked(balance: bigint, amount: bigint): bigint {
  if (balance < 0n || amount <= 0n) return 0n;
  return withdraw(balance, amount);
}
