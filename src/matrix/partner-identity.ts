export interface PartnerIdentityEnvironment {
  partnerA?: string;
  partnerB?: string;
  mode: string;
  development: boolean;
}

export interface PartnerIdentities {
  partnerA: string;
  partnerB: string;
}

export function getPartnerIdentities(environment: PartnerIdentityEnvironment): PartnerIdentities {
  const isDevelopment = environment.development || environment.mode === 'android';
  return {
    partnerA: environment.partnerA?.trim() || (isDevelopment ? '@partner1-dev:localhost' : ''),
    partnerB: environment.partnerB?.trim() || (isDevelopment ? '@partner2-dev:localhost' : ''),
  };
}

export const PARTNER_IDENTITIES = getPartnerIdentities({
  partnerA: import.meta.env?.VITE_MATRIX_PARTNER_A_USER_ID,
  partnerB: import.meta.env?.VITE_MATRIX_PARTNER_B_USER_ID,
  mode: import.meta.env?.MODE ?? 'production',
  development: import.meta.env?.DEV ?? false,
});

export const PARTNER_DEVICE_IDS = {
  partnerA: import.meta.env?.VITE_MATRIX_PARTNER_A_DEVICE_ID?.trim() || '',
  partnerB: import.meta.env?.VITE_MATRIX_PARTNER_B_DEVICE_ID?.trim() || '',
};
