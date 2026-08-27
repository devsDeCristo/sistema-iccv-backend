import { ApiProperty } from '@nestjs/swagger';
import { EventStatus, EventType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

class RoleDto {
  @IsOptional()
  @IsString()
  groupId: string;

  @IsOptional()
  @IsString()
  id?: string;

  @IsNumber()
  price: number;

  @IsString()
  description: string;
}

class GroupRoleDto {
  @IsString()
  @IsOptional()
  eventId?: string;

  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  name: string;

  @IsInt()
  capacity: number;

  @ApiProperty({
    example: 'https://chat.whatsapp.com/xxxxxxxxxxxxxxxxxxxx',
    description: 'Link do grupo de whatsapp deste grupo (opcional)',
    required: false,
  })
  @IsOptional()
  @IsString()
  link?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoleDto)
  roles: RoleDto[];
}
export class EventDto {
  @ApiProperty({
    example: 'Retiro 2023',
    description: 'Nome do evento',
  })
  @IsString()
  name: string;

  @ApiProperty({
    example: 'https://chat.whatsapp.com/xxxxxxxxxxxxxxxxxxxx',
    description: 'Link do grupo do whatsapp',
  })
  @IsString()
  @IsOptional()
  groupLink: string;

  @ApiProperty({
    enum: EventStatus,
    example: EventStatus.ACTIVE,
    description:
      'Status do evento. TEST só aparece na área do usuário para admin e super admin',
  })
  @Transform(({ value }) => {
    // multipart manda tudo como texto; o booleano antigo ainda chega de
    // clientes que não foram atualizados
    if (value === true || value === 'true') return EventStatus.ACTIVE;
    if (value === false || value === 'false') return EventStatus.INACTIVE;
    return typeof value === 'string' ? value.toUpperCase() : value;
  })
  @IsEnum(EventStatus)
  status: EventStatus;

  @ApiProperty({
    example: '2023-02-17',
    description: 'Data que devera acontecer o evento',
  })
  @IsDateString()
  startDate: Date;

  @ApiProperty({
    example: '2023-02-17',
    description: 'Data que devera encerrar o evento',
  })
  @IsDateString()
  endDate: Date;

  @ApiProperty({
    description: 'Grupos de regras do evento',
    example: [
      {
        id: 'uuid-v4',
        name: 'Grupo 1',
        capacity: 100,
        roles: [
          {
            id: 'uuid-v4',
            price: 100.0,
            description: 'Descrição da regra 1',
          },
          {
            price: 150.0,
            description: 'Descrição da regra 2',
          },
        ],
      },
    ],
  })
  @Transform(({ value }) => {
    // Se for string, faz JSON.parse primeiro
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        return [];
      }
    }
    // Agora trata como array e converte para instâncias de GroupRoleDto
    if (Array.isArray(value)) {
      const transformed = value.map((groupRole) =>
        Object.assign(new GroupRoleDto(), groupRole),
      );
      const transformedWithTypes = transformed.map((groupRole) => {
        groupRole.roles = groupRole.roles.map((role) =>
          Object.assign(new RoleDto(), role),
        );
        return groupRole;
      });
      return transformedWithTypes;
    }
    return [];
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GroupRoleDto)
  groupRoles?: GroupRoleDto[];

  @ApiProperty({
    example: { local: 'Auditório Principal', address: 'Rua XYZ, 123' },
    description: 'Dados adicionais do evento',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? JSON.parse(value) : value,
  )
  @IsObject()
  @IsOptional()
  data: Object;
  @ApiProperty({
    example: 'CURSILHO',
    description: 'Tipo do evento',
  })
  @IsString()
  type: EventType;

  @ApiProperty({
    description: 'File da logo do evento',
    type: 'string',
    format: 'binary',
    required: false,
  })
  @IsOptional()
  logoFile?: Express.Multer.File;

  @ApiProperty({
    description: 'File da capa do evento',
    type: 'string',
    format: 'binary',
    required: false,
  })
  @IsOptional()
  coverFile?: Express.Multer.File;
}
export class roleEventDto {
  @ApiProperty({
    description: 'IDs das regras de inscrição atribuídas ao usuário no evento',
    example: ['uuid-v4', 'uuid-v4'],
  })
  @IsString({ each: true })
  roleRegistrationId: string[];
}
