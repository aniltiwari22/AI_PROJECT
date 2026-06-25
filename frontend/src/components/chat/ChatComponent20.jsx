import React from 'react';
import ChatComponent1 from './ChatComponent1';

// Standardized unified cascade matching components schema specs cleanly
export default function ExtendedChatInterfaceWrapper({ message }) {
  return <ChatComponent1 message={message} />;
}