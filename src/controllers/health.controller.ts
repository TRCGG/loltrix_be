import { Request, Response } from 'express';

/**
 * @desc Health check endpoint
 * @access Public
 */
export const getHealth = (req: Request, res: Response) => {
  res.status(200).json({
    status: 'success',
    message: 'Server is healthy',
    timestamp: new Date().toISOString(),
  });
};
