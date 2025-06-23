import { Request, Response } from 'express';

/**
 * @desc Create a new example
 * @access Public
 */
export const createExample = (req: Request, res: Response) => {
  // In a real app, you would save to a database here
  res.status(201).json({
    status: 'success',
    message: 'Example created successfully',
    data: req.body,
  });
};

/**
 * @desc Get example by ID
 * @access Public
 */
export const getExampleById = (req: Request, res: Response) => {
  // In a real app, you would fetch from a database here
  res.status(200).json({
    status: 'success',
    message: 'Example retrieved successfully',
    data: {
      id: req.params.id,
      name: 'Example Name',
      email: 'example@example.com',
      age: 30,
      tags: ['tag1', 'tag2'],
    },
  });
};

/**
 * @desc Get all examples
 * @access Public
 */
export const getAllExamples = (req: Request, res: Response) => {
  // In a real app, you would fetch from a database here
  res.status(200).json({
    status: 'success',
    message: 'Examples retrieved successfully',
    data: [
      {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: 'Example 1',
        email: 'example1@example.com',
      },
      {
        id: '223e4567-e89b-12d3-a456-426614174000',
        name: 'Example 2',
        email: 'example2@example.com',
      },
    ],
  });
};
