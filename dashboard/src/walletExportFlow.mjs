export async function resolveWalletExportPassword({securityPasswordSet,enteredPassword,setupPassword}) {
  if (securityPasswordSet) return enteredPassword;
  return setupPassword();
}
