import { contract } from "../src/contract.js";

export function withdraw(balance: number, amount: number): number {
  return balance - amount;
}

contract(withdraw, {
  requires: (balance, amount) => balance >= 0 && amount > 0 && amount <= balance,
  ensures: (result, balance, amount) => result >= 0 && result === balance - amount,
});

export function payChecked(balance: number, amount: number): number {
  if (balance < 0 || amount <= 0 || amount > balance) return 0;
  return withdraw(balance, amount);
}

export function payUnchecked(balance: number, amount: number): number {
  if (balance < 0 || amount <= 0) return 0;
  return withdraw(balance, amount);
}
