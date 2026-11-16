import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { CategoriesService } from './categories.service.js';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get() list() { return this.categories.list(); }
  @Post() create(@Body() body: Record<string, unknown>) { return this.categories.create(body); }
  @Patch(':name') rename(@Param('name') name: string, @Body() body: Record<string, unknown>) { return this.categories.rename(name, body); }
  @Delete(':name') remove(@Param('name') name: string, @Body() body: Record<string, unknown>) { return this.categories.remove(name, body); }
}
