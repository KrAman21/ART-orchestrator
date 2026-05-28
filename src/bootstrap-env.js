import dotenv from 'dotenv';

const shouldLoadDotenv = process.env.ART_USE_DOTENV !== 'false';

if (shouldLoadDotenv) {
  dotenv.config();
}

export { shouldLoadDotenv };
