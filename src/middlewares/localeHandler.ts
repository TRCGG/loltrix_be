import { Request, Response, NextFunction } from 'express';

/**
 * @desc locale header set middle-ware
 */

// req 타입 확장: locale 프로퍼티 추가
declare module 'express-serve-static-core' {
  interface Request {
    locale?: string;
  }
}

export const localeHandler = async (
  req: Request,
  res: Response, 
  next: NextFunction
): Promise<void> =>{
  const acceptLangCode = req.headers['accept-language'];
  console.log(acceptLangCode);
  req.locale = acceptLangCode?.split(',')[0] || 'ko' // 한국 기본
  next();
}
