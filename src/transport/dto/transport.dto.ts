import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNumber, IsOptional, IsString } from 'class-validator';

export class TransportDto {
  @ApiProperty({
    example: 'Sai da igreja às 6h',
    description: 'Qualquer observação sobre o transporte',
  })
  @IsString()
  @IsOptional()
  note?: string;

  @ApiProperty({
    example: 'Ônibus 1',
    description: 'Nome do transporte',
  })
  @IsString()
  name: string;

  @ApiProperty({
    example: 45,
    description: 'Quantos lugares o transporte tem',
  })
  @IsNumber()
  capacity: number;

  @ApiProperty({
    example: ['Van', 'Acessível'],
    description: 'nomes das tags',
  })
  @IsArray()
  tags: string[];

  @ApiProperty({
    example: ['Servos', 'Cursilhistas'],
    description:
      'Nomes de grupos de inscrição que podem ocupar o transporte. Vazio deixa aberto a qualquer inscrito; preenchido restringe a esses grupos.',
    required: false,
  })
  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  groupTags?: string[];

  @ApiProperty({
    example: ['uuid-1', 'uuid-2'],
    description: 'ids dos usuários que ocupam os lugares',
  })
  @IsArray()
  // cada item precisa ser texto: sem isto, um número ou objeto no meio da lista
  // só falharia lá dentro, na consulta
  @IsString({ each: true })
  usersId: string[];
}
