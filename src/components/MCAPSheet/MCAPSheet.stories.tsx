import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { MCAPSheet } from './MCAPSheet';
import type { TopicWorksheet } from './types';

const sampleWorkbook: TopicWorksheet[] = [
  {
    topic: '/imu',
    columns: ['_logTime', 'header.frame_id', 'linear_acceleration.x', 'linear_acceleration.y'],
    rows: [
      {
        _logTime: '1000000000',
        'header.frame_id': 'base_link',
        'linear_acceleration.x': 0.3,
        'linear_acceleration.y': -0.1,
      },
      {
        _logTime: '2000000000',
        'header.frame_id': 'base_link',
        'linear_acceleration.x': 0.2,
        'linear_acceleration.y': -0.2,
      },
    ],
  },
  {
    topic: '/gps',
    columns: ['_logTime', 'fix.latitude', 'fix.longitude'],
    rows: [
      {
        _logTime: '3000000000',
        'fix.latitude': 37.789,
        'fix.longitude': -122.401,
      },
    ],
  },
];

const meta = {
  component: MCAPSheet,
  args: {
    url: 'https://example.com/sample.mcap',
    dataLoader: async () => sampleWorkbook,
    height: 420,
  },
  tags: ['ai-generated'],
} satisfies Meta<typeof MCAPSheet>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithColumnFilter: Story = {
  play: async ({ canvas, userEvent }) => {
    const input = canvas.getByLabelText('Filter header.frame_id');
    await userEvent.type(input, 'base_link');
    await expect(canvas.getByText('base_link')).toBeVisible();
  },
};

export const CssCheck: Story = {
  play: async ({ canvas }) => {
    const tab = canvas.getByRole('button', { name: '/imu' });
    await expect(getComputedStyle(tab).backgroundColor).toBe('rgb(255, 255, 255)');
  },
};
