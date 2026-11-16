import { BadRequestException, Controller, Delete, Get, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { FilesService } from './files.service.js';

@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }))
  upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Choose a file to upload');
    return this.files.upload(file);
  }

  @Get() list() { return this.files.list(); }
  @Get(':id/url') signedUrl(@Param('id') id: string) { return this.files.signedUrl(id); }
  @Delete(':id') remove(@Param('id') id: string) { return this.files.remove(id); }
}
